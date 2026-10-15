// 명령 노드: 흐름 그래프에서 세션 사이에 끼워 두는 셸 명령(빌드, 테스트 등).
// 연결로 넘어오면 실행하고, 종료 코드 0이면 성공, 아니면 실패로 보고 다음 연결로 넘긴다.
// data/commands.json 하나에 저장한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const isWindows = process.platform === "win32";
export const COMMAND_PREFIX = "cmd-";
export const isCommandId = (id) => typeof id === "string" && id.startsWith(COMMAND_PREFIX);
export const commandKind = (command) => command?.kind ?? "command";
export const COMMAND_KINDS = ["command", "button", "markdown"];
export const CWD_MODES = ["source", "project"]; // 보낸 세션의 작업 폴더 | 프로젝트 폴더
const OUTPUT_MAX = 200_000; // 메모리에 남기는 출력
const TAIL_LINES = 60; // 다음 세션에 넘기는 출력 줄 수
const TAIL_CHARS = 8000;
export const TIMEOUT_DEFAULT = 600;
export const TIMEOUT_MAX = 3600;

// ── 셸 ─────────────────────────────────────────────────────────
let pwshPath;
function findPwsh() {
  if (pwshPath !== undefined) return pwshPath;
  pwshPath = null;
  try {
    const out = execFileSync(isWindows ? "where" : "which", ["pwsh"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    pwshPath = out.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
  } catch {
    // 설치되지 않음
  }
  return pwshPath;
}

// 이 PC에서 고를 수 있는 셸. 첫 번째가 기본값이다.
export function shells() {
  if (!isWindows) return [{ id: "sh", label: "sh" }];
  const list = [{ id: "powershell", label: "PowerShell" }, { id: "cmd", label: "CMD" }];
  if (findPwsh()) list.push({ id: "pwsh", label: "PowerShell 7" });
  return list;
}

// PowerShell: 출력은 UTF-8로, 마지막 명령이 실패하면 그 종료 코드(없으면 1)로 끝낸다.
function powershellScript(command) {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = [Text.Encoding]::UTF8",
    "$global:LASTEXITCODE = 0",
    command,
    // $?는 바로 앞(마지막) 명령의 성공 여부다. 스크립트 블록으로 감싸면 cmdlet 실패가 가려지므로 그대로 둔다.
    "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }",
    "exit $LASTEXITCODE",
  ].join("\n");
}

// 셸마다 실행 방법이 다르다. cleanup은 끝난 뒤 지울 임시 파일.
function shellInvocation(shell, command) {
  if (shell === "powershell" || shell === "pwsh") {
    const exe = shell === "pwsh" ? findPwsh() ?? "pwsh" : "powershell.exe";
    // 임시 .ps1 파일로 실행한다(-EncodedCommand는 오류를 CLIXML로 내보낸다). 5.1이 한글을 읽도록 BOM을 붙인다.
    const file = path.join(os.tmpdir(), `agenthub-${randomBytes(6).toString("hex")}.ps1`);
    fs.writeFileSync(file, `﻿${powershellScript(command)}`);
    return { file: exe, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], cleanup: file };
  }
  if (shell === "cmd") {
    // 여러 줄 명령을 그대로 쓰도록 임시 .cmd 파일로 실행한다. 코드 페이지를 UTF-8로 바꿔 한글이 깨지지 않게 한다.
    const file = path.join(os.tmpdir(), `agenthub-${randomBytes(6).toString("hex")}.cmd`);
    fs.writeFileSync(file, `@echo off\r\nchcp 65001 >nul\r\n${command.replace(/\r?\n/g, "\r\n")}\r\nexit /b %errorlevel%\r\n`);
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", `"${file}"`], verbatim: true, cleanup: file };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

function killTree(child) {
  if (!child?.pid) return;
  if (isWindows) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  else child.kill("SIGTERM");
}

// 출력 마지막 부분(다음 세션에 넘기거나 카드에 보인다)
export function outputTail(output, lines = TAIL_LINES, chars = TAIL_CHARS) {
  const tail = output.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");
  return tail.length > chars ? `…${tail.slice(-chars)}` : tail;
}

// 명령을 한 번 실행한다. onOutput은 출력이 올 때마다 불린다. 결과: { exitCode, output, timedOut, stopped, durationMs }
export function runShell({ shell, command, cwd, timeoutSec = TIMEOUT_DEFAULT, onOutput = () => {} }) {
  const started = Date.now();
  const { file, args, verbatim, cleanup } = shellInvocation(shell, command);
  let output = "";
  let timedOut = false;
  let stopped = false;
  const child = spawn(file, args, {
    cwd,
    windowsHide: true,
    windowsVerbatimArguments: !!verbatim,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  const add = (chunk) => {
    output += chunk;
    if (output.length > OUTPUT_MAX) output = output.slice(-OUTPUT_MAX);
    onOutput(output);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, Math.min(TIMEOUT_MAX, Math.max(1, timeoutSec)) * 1000);
  const done = new Promise((resolve) => {
    let finished = false;
    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (cleanup) fs.rmSync(cleanup, { force: true });
      if (timedOut) add(`\n(시간 제한 ${timeoutSec}초를 넘어 중지했습니다)`);
      resolve({ exitCode: timedOut || stopped ? exitCode || 1 : exitCode ?? 1, output, timedOut, stopped, durationMs: Date.now() - started });
    };
    child.on("error", (err) => {
      add(`\n실행 실패: ${err.message}`);
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
  return {
    done,
    stop() {
      stopped = true;
      killTree(child);
    },
  };
}

export { CommandStore } from "./infrastructure/persistence/command-store.mjs";

export const newCommandId = () => `${COMMAND_PREFIX}${randomBytes(4).toString("hex")}`;

// 입력을 검사해 저장할 값만 돌려준다. 틀리면 오류를 던진다.
export function checkCommand(body, current = {}) {
  const kind = body.kind === undefined ? commandKind(current) : body.kind;
  if (!COMMAND_KINDS.includes(kind)) throw new Error("노드 종류가 올바르지 않습니다.");
  if (current.id && kind !== commandKind(current)) throw new Error("만든 노드의 종류는 바꿀 수 없습니다.");
  const title = String(body.title ?? current.title ?? "").trim().slice(0, 100);
  const cwdMode = body.cwdMode ?? current.cwdMode ?? "source";
  if (!CWD_MODES.includes(cwdMode)) throw new Error("실행 폴더 설정이 올바르지 않습니다.");
  if (kind === "button") {
    const prompt = String(body.prompt ?? current.prompt ?? "").trim();
    if (!prompt) throw new Error("버튼을 눌렀을 때 보낼 요청을 적으세요.");
    if (prompt.length > 20000) throw new Error("요청은 20,000자까지 입력할 수 있습니다.");
    return { kind, title: title || "실행 버튼", prompt };
  }
  if (kind === "markdown") return { kind, title: title || "MD 출력", cwdMode };
  const command = String(body.command ?? current.command ?? "").replace(/\s+$/, "");
  if (!command.trim()) throw new Error("실행할 명령을 적으세요.");
  if (command.length > 20000) throw new Error("명령이 너무 깁니다.");
  const shell = body.shell ?? current.shell ?? shells()[0].id;
  if (!shells().some((s) => s.id === shell)) throw new Error("이 PC에서 쓸 수 없는 셸입니다.");
  const timeoutSec = Math.round(Number(body.timeoutSec ?? current.timeoutSec ?? TIMEOUT_DEFAULT));
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > TIMEOUT_MAX) throw new Error(`시간 제한은 1~${TIMEOUT_MAX}초입니다.`);
  return { title: title || command.trim().split(/\r?\n/)[0].slice(0, 60), command, shell, cwdMode, timeoutSec };
}

// 명령 노드에서 다음 세션으로 넘기는 내용
export function commandHandoffText(cmd, run, link, origin) {
  const ok = run.exitCode === 0;
  return [
    "[명령 노드에서 넘어온 결과]",
    `명령: ${cmd.title} (${cmd.shell})`,
    "```",
    cmd.command,
    "```",
    `실행 폴더: ${run.cwd}`,
    `결과: ${ok ? "성공" : "실패"} (종료 코드 ${run.exitCode}${run.timedOut ? ", 시간 초과" : ""})`,
    origin ? `이 명령을 실행시킨 세션: ${origin.title}` : null,
    "",
    "출력(마지막 부분):",
    run.tail || "(출력 없음)",
    "",
    link.note?.trim() || (ok ? "이 결과를 이어받아 네 역할에 맞게 처리하라." : "명령이 실패했다. 출력을 보고 원인을 찾아 고쳐라."),
  ].filter((line) => line !== null).join("\n");
}

// ── 생성 ───────────────────────────────────────────────────────
// 하고 싶은 일을 적으면 CLI가 셸 명령을 써 준다. 답에서 JSON 객체를 꺼낸다.
export function generatePrompt({ prompt, shell, projectPath }) {
  const name = shells().find((s) => s.id === shell)?.label ?? shell;
  return [
    `너는 ${isWindows ? "Windows" : "Unix"}용 ${name} 명령을 써 주는 도우미다.`,
    `프로젝트 폴더: ${projectPath} (명령은 이 폴더나 같은 저장소의 작업 폴더에서 실행된다)`,
    "필요하면 package.json, Makefile 같은 파일을 읽어 이 프로젝트에 맞는 명령을 고른다. 파일을 고치거나 명령을 실행하지 않는다.",
    `${name} 문법으로 쓴다.${shell === "powershell" ? " Windows PowerShell 5.1이므로 &&, || 대신 ; 와 if ($LASTEXITCODE) 를 쓴다." : ""}`,
    "실패하면 0이 아닌 종료 코드로 끝나야 한다. 사용자 입력을 기다리는 명령은 쓰지 않는다.",
    "답은 아래 JSON 객체 하나만 쓴다. 다른 말은 쓰지 않는다.",
    '{"title": "짧은 이름", "command": "실행할 명령(여러 줄 가능)", "explanation": "무엇을 하는지 한두 문장"}',
    "",
    `하고 싶은 일: ${prompt}`,
  ].join("\n");
}

export function parseGenerated(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("명령을 만들지 못했습니다. 다시 시도해 보세요.");
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("명령을 만들지 못했습니다(답이 JSON 형식이 아님).");
  }
  const command = String(data.command ?? "").trim();
  if (!command) throw new Error("명령을 만들지 못했습니다(빈 명령).");
  return { title: String(data.title ?? "").trim().slice(0, 100), command, explanation: String(data.explanation ?? "").trim() };
}
