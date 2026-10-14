// AgentHub.exe: Node 서버를 창 없이 실행하고 브라우저를 연 뒤 트레이에 머무는 런처.
// launcher\build.ps1이 Windows 기본 C# 컴파일러(csc.exe, .NET Framework 4)로 빌드한다.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("AgentHub")]
[assembly: System.Reflection.AssemblyProduct("AgentHub")]
[assembly: System.Reflection.AssemblyVersion("0.1.0.0")]

static class Launcher
{
    static string root;
    static string dataDir;
    static int port;
    static Process server;
    static NotifyIcon tray;
    static bool quitting;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();

        root = FindRoot();
        if (root == null)
        {
            Fail("server\\index.mjs를 찾을 수 없습니다.\nAgentHub.exe를 AgentHub 폴더 안에 두세요.");
            return;
        }
        dataDir = Environment.GetEnvironmentVariable("AGENTHUB_DATA") ?? Path.Combine(root, "data");
        port = ReadPort();

        bool created;
        using (var mutex = new Mutex(true, "AgentHub.Launcher." + port, out created))
        {
            // 이미 실행 중이면(런처든 npm start든) 브라우저만 연다.
            if (!created || IsServerUp())
            {
                OpenBrowser();
                return;
            }
            if (!StartServer()) return;
            ShowTray();
            Application.Run();
        }
    }

    static string Url { get { return "http://127.0.0.1:" + port + "/"; } }

    static string FindRoot()
    {
        var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        for (int i = 0; dir != null && i < 3; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "server", "index.mjs"))) return dir.FullName;
        return null;
    }

    static int ReadPort()
    {
        int value;
        if (int.TryParse(Environment.GetEnvironmentVariable("PORT"), out value)) return value;
        try
        {
            var json = File.ReadAllText(Path.Combine(dataDir, "config.json"));
            var m = Regex.Match(json, "\"port\"\\s*:\\s*(\\d+)");
            if (m.Success && int.TryParse(m.Groups[1].Value, out value)) return value;
        }
        catch { }
        return 4517;
    }

    static string FindNode()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(';'))
        {
            try
            {
                var file = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (dir.Trim().Length > 0 && File.Exists(file)) return file;
            }
            catch { }
        }
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var fallback = Path.Combine(programFiles, "nodejs", "node.exe");
        return File.Exists(fallback) ? fallback : null;
    }

    static bool IsServerUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = 1000;
            req.Proxy = null;
            using (var res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static string LogPath { get { return Path.Combine(dataDir, "agenthub.log"); } }

    static bool StartServer()
    {
        var node = FindNode();
        if (node == null)
        {
            Fail("Node.js(node.exe)를 찾을 수 없습니다.\nNode.js 20 이상을 설치하세요.");
            return false;
        }

        Directory.CreateDirectory(dataDir);
        var log = new StreamWriter(LogPath, false) { AutoFlush = true };
        log.WriteLine("[" + DateTime.Now.ToString("s") + "] " + node);

        var info = new ProcessStartInfo(node, "\"" + Path.Combine(root, "server", "index.mjs") + "\"")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.EnvironmentVariables["AGENTHUB_LAUNCHER"] = "1";
        info.EnvironmentVariables["PORT"] = port.ToString();

        server = new Process { StartInfo = info, EnableRaisingEvents = true };
        DataReceivedEventHandler write = (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
        server.OutputDataReceived += write;
        server.ErrorDataReceived += write;
        server.Exited += (s, e) => OnServerExited();
        server.Start();
        Job.Attach(server);
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();

        // 서버가 응답할 때까지 기다렸다가 브라우저를 연다.
        var deadline = DateTime.Now.AddSeconds(20);
        while (DateTime.Now < deadline)
        {
            if (server.HasExited) return false; // OnServerExited가 오류를 보여 준다.
            if (IsServerUp())
            {
                OpenBrowser();
                return true;
            }
            Thread.Sleep(250);
        }
        Fail("서버가 20초 안에 응답하지 않았습니다.\n로그: " + LogPath);
        Quit();
        return false;
    }

    static void OnServerExited()
    {
        if (quitting) return;
        quitting = true;
        string tail = "";
        try
        {
            var lines = File.ReadAllLines(LogPath);
            tail = string.Join("\n", lines, Math.Max(0, lines.Length - 12), Math.Min(12, lines.Length));
        }
        catch { }
        Fail("AgentHub 서버가 종료되었습니다.\n\n" + tail + "\n\n로그: " + LogPath);
        if (tray != null) tray.Visible = false;
        Application.Exit();
        Environment.Exit(1);
    }

    static void ShowTray()
    {
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("AgentHub 열기", null, (s, e) => OpenBrowser());
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add("로그 보기", null, (s, e) => Process.Start("notepad.exe", "\"" + LogPath + "\""));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("종료", null, (s, e) => Quit());

        tray = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "AgentHub - 127.0.0.1:" + port,
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenBrowser(); };
    }

    static Icon LoadIcon()
    {
        using (var stream = typeof(Launcher).Assembly.GetManifestResourceStream("agenthub.ico"))
            return stream != null ? new Icon(stream, SystemInformation.SmallIconSize) : SystemIcons.Application;
    }

    // stdin을 닫으면 서버가 세션을 저장하고 종료한다. 남은 에이전트 프로세스는 Job 객체가 정리한다.
    static void Quit()
    {
        quitting = true;
        if (tray != null) tray.Visible = false;
        if (server != null && !server.HasExited)
        {
            try { server.StandardInput.Close(); } catch { }
            if (!server.WaitForExit(5000)) try { server.Kill(); } catch { }
        }
        Application.Exit();
    }

    static void OpenBrowser()
    {
        try { Process.Start(Url); } catch { }
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, "AgentHub", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

// 런처가 끝나면(비정상 종료 포함) 서버와 그 하위 프로세스가 함께 종료되게 한다.
static class Job
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int ExtendedLimitInformationClass = 9;
    const uint KillOnJobClose = 0x2000;
    static IntPtr handle; // 프로세스가 끝날 때까지 닫지 않는다.

    public static void Attach(Process process)
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return;
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = KillOnJobClose;
        SetInformationJobObject(handle, ExtendedLimitInformationClass, ref info, Marshal.SizeOf(info));
        AssignProcessToJobObject(handle, process.Handle);
    }
}
