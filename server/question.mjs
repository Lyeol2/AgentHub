// 에이전트가 사용자에게 묻는 질문. Claude Code의 AskUserQuestion처럼 선택지를 보여 주고, 고른 답을 다음 요청으로 보낸다.
// CLI를 비대화로 실행하므로 질문 도구 대신 답변 끝의 질문 블록으로 받는다(Claude·Codex 공통).
export const QUESTION_FENCE = "agenthub-question";
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

export const QUESTION_GUIDE = `[AgentHub 질문 규칙]
사용자의 결정 없이는 진행할 수 없을 때만, 답변 맨 끝에 아래 형식의 코드 블록 하나를 쓰고 턴을 끝낸다.
AgentHub가 선택지로 보여 주고, 사용자가 고른 답은 다음 요청으로 온다. 합리적으로 정할 수 있는 것은 묻지 말고 진행한다.
\`\`\`${QUESTION_FENCE}
{"questions": [{"header": "짧은 제목", "question": "무엇을 고를지 묻는 문장", "multiSelect": false,
  "options": [{"label": "선택지", "description": "고르면 어떻게 되는지"}]}]}
\`\`\`
- 질문은 ${MAX_QUESTIONS}개까지, 질문마다 선택지는 2~${MAX_OPTIONS}개. 사용자는 선택지 대신 직접 답을 적을 수도 있다.
- 블록 앞에는 왜 묻는지 짧게 쓴다.`;

const str = (value, max) => String(value ?? "").trim().slice(0, max);

// 답변에서 마지막 질문 블록을 꺼낸다. 없으면 null, 형식이 틀리면 { error }.
export function extractQuestions(text) {
  const blocks = [...text.matchAll(new RegExp("```" + QUESTION_FENCE + "\\s*\\n([\\s\\S]*?)```", "g"))];
  if (!blocks.length) return null;
  let raw;
  try {
    raw = JSON.parse(blocks.at(-1)[1]);
  } catch (err) {
    return { error: `질문 블록이 JSON 형식이 아닙니다: ${err.message}` };
  }
  const questions = (Array.isArray(raw?.questions) ? raw.questions : []).slice(0, MAX_QUESTIONS).map((q) => ({
    header: str(q?.header, 40),
    question: str(q?.question, 1000),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({ label: str(o?.label ?? o, 200), description: str(o?.description, 500) }))
      .filter((o) => o.label),
  })).filter((q) => q.question);
  if (!questions.length) return { error: "질문 블록에 질문이 없습니다." };
  return { questions };
}

// 사용자가 고른 답을 에이전트에게 보낼 요청으로 만든다. answers[i]: { selected: [label...], text }
export function answerPrompt(questions, answers) {
  const lines = ["[질문에 대한 사용자의 답]"];
  questions.forEach((q, i) => {
    const a = answers?.[i] ?? {};
    const picked = (Array.isArray(a.selected) ? a.selected : []).filter((label) => q.options.some((o) => o.label === label));
    const text = str(a.text, 4000);
    const answer = [...picked, text].filter(Boolean).join(", ") || "(답하지 않음)";
    lines.push(`- ${q.question}\n  → ${answer}`);
  });
  return lines.join("\n");
}

// 답이 하나라도 있는지
export const hasAnswer = (answers) =>
  Array.isArray(answers) && answers.some((a) => (Array.isArray(a?.selected) && a.selected.length) || str(a?.text, 1));
