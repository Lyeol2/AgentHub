# AgentHub 아이콘(launcher/agenthub.ico)을 만든다. 외부 도구 없이 System.Drawing으로 그린다.
# 16/32/48 크기는 BMP 프레임으로, 256 크기는 PNG 프레임으로 넣는다.
param([string]$Out = (Join-Path $PSScriptRoot "agenthub.ico"))

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class AgentHubIcon {
  static Color Hex(string h) { return ColorTranslator.FromHtml(h); }

  // 256 기준 좌표로 그린 뒤 크기에 맞게 줄인다.
  public static Bitmap Draw(int size) {
    var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.Clear(Color.Transparent);
      float s = size / 256f;
      g.ScaleTransform(s, s);

      // 배경: 둥근 사각형, 파란 그라데이션
      var rect = new RectangleF(8, 8, 240, 240);
      using (var path = Rounded(rect, 56))
      using (var bg = new LinearGradientBrush(rect, Hex("#3b7be6"), Hex("#1d4ea6"), 90f))
        g.FillPath(bg, path);

      // 허브: 가운데 노드와 세 개의 위성 노드
      var center = new PointF(128, 136);
      var claude = new PointF(70, 78);
      var codex = new PointF(186, 78);
      var bottom = new PointF(128, 204);
      float line = size <= 16 ? 22 : size <= 32 ? 16 : 13;
      using (var pen = new Pen(Color.FromArgb(220, 255, 255, 255), line)) {
        pen.StartCap = pen.EndCap = LineCap.Round;
        g.DrawLine(pen, center, claude);
        g.DrawLine(pen, center, codex);
        g.DrawLine(pen, center, bottom);
      }
      float sat = size <= 16 ? 34 : 28;
      Dot(g, claude, sat, Hex("#e8875c"));
      Dot(g, codex, sat, Hex("#4cc28a"));
      Dot(g, bottom, sat * 0.8f, Hex("#cfe0ff"));
      Dot(g, center, size <= 16 ? 40 : 36, Color.White);
    }
    return bmp;
  }

  static void Dot(Graphics g, PointF c, float r, Color color) {
    using (var b = new SolidBrush(color)) g.FillEllipse(b, c.X - r, c.Y - r, r * 2, r * 2);
  }

  static GraphicsPath Rounded(RectangleF r, float radius) {
    var p = new GraphicsPath();
    float d = radius * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  static byte[] Png(Bitmap bmp) {
    using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
  }

  // 32bpp DIB(아래에서 위로) + AND 마스크
  static byte[] Dib(Bitmap bmp) {
    int n = bmp.Width;
    int maskStride = ((n + 31) / 32) * 4;
    using (var ms = new MemoryStream())
    using (var w = new BinaryWriter(ms)) {
      w.Write(40); w.Write(n); w.Write(n * 2); w.Write((short)1); w.Write((short)32);
      w.Write(0); w.Write(n * n * 4 + maskStride * n); w.Write(0); w.Write(0); w.Write(0); w.Write(0);
      for (int y = n - 1; y >= 0; y--)
        for (int x = 0; x < n; x++) {
          var c = bmp.GetPixel(x, y);
          w.Write(c.B); w.Write(c.G); w.Write(c.R); w.Write(c.A);
        }
      w.Write(new byte[maskStride * n]);
      return ms.ToArray();
    }
  }

  public static void Save(string file) {
    int[] sizes = { 16, 24, 32, 48, 256 };
    var frames = new byte[sizes.Length][];
    for (int i = 0; i < sizes.Length; i++)
      using (var bmp = Draw(sizes[i])) frames[i] = sizes[i] >= 256 ? Png(bmp) : Dib(bmp);

    using (var fs = File.Create(file))
    using (var w = new BinaryWriter(fs)) {
      w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
      int offset = 6 + 16 * sizes.Length;
      for (int i = 0; i < sizes.Length; i++) {
        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
        w.Write((byte)0); w.Write((byte)0);
        w.Write((short)1); w.Write((short)32);
        w.Write(frames[i].Length); w.Write(offset);
        offset += frames[i].Length;
      }
      foreach (var f in frames) w.Write(f);
    }
  }

  public static void SavePng(string file, int size) {
    using (var bmp = Draw(size)) bmp.Save(file, ImageFormat.Png);
  }
}
"@

[AgentHubIcon]::Save($Out)
[AgentHubIcon]::SavePng([IO.Path]::ChangeExtension($Out, ".png"), 256)
Write-Host "아이콘: $Out"
