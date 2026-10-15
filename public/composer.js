// 글이나 이미지가 있으면 보내고, 비어 있으면 현재 작업을 일시중지하거나 재개한다.
export function composerAction(session, text = "", attachmentCount = 0) {
  const hasContent = !!text.trim() || attachmentCount > 0;
  if (!hasContent && session?.state === "running" && session.paused) {
    return { action: "pausing", label: "멈추는 중", icon: "⏸", title: "작업을 멈추고 있습니다. 잠시 기다려 주세요.", disabled: true };
  }
  if (!hasContent && session?.state === "running") {
    return { action: "pause", label: "일시중지", icon: "⏸", title: "현재 작업을 일시중지합니다. 입력하면 대기열에 요청을 추가할 수 있습니다.", disabled: false };
  }
  if (!hasContent && session?.state === "paused") {
    return { action: "resume", label: "재개", icon: "▶", title: "멈춘 곳부터 이어서 진행합니다.", disabled: false };
  }
  if (session?.state === "running") {
    return { action: "queue", label: "대기열에 추가", icon: "↑", title: "지금 작업이 끝나면 보냅니다 (Enter). 입력을 비우면 일시중지할 수 있습니다.", disabled: !hasContent };
  }
  return {
    action: "send", label: "보내기", icon: "↑", disabled: !hasContent,
    title: session?.state === "paused" ? "이 요청을 보내고 일시중지를 해제합니다 (Enter)." : "요청을 보냅니다 (Enter).",
  };
}
