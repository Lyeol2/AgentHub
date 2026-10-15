import test from "node:test";
import assert from "node:assert/strict";
import { extractQuestions, answerPrompt, hasAnswer } from "../server/question.mjs";

test("question: 답변 끝의 질문 블록을 꺼낸다", () => {
  const text = "어느 쪽으로 할지 정해 주세요.\n```agenthub-question\n" +
    JSON.stringify({ questions: [{ header: "저장", question: "어디에 저장할까요?", options: [{ label: "로컬" }, { label: "서버", description: "API 필요" }] }] }) +
    "\n```";
  const { questions } = extractQuestions(text);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].options[1].description, "API 필요");
  assert.equal(questions[0].multiSelect, false);
  assert.equal(extractQuestions("질문 없음"), null);
  assert.ok(extractQuestions("```agenthub-question\n{틀림\n```").error);
});

test("question: 고른 답과 적은 답을 요청으로 만든다", () => {
  const questions = [{ question: "어디에?", options: [{ label: "로컬" }, { label: "서버" }] }, { question: "이름은?", options: [] }];
  const prompt = answerPrompt(questions, [{ selected: ["서버", "없는 선택지"] }, { text: "foo" }]);
  assert.match(prompt, /어디에\?\n {2}→ 서버$/m);
  assert.match(prompt, /→ foo/);
  assert.ok(!prompt.includes("없는 선택지"));
  assert.equal(hasAnswer([{ selected: [] }, { text: " " }]), false);
  assert.equal(hasAnswer([{ selected: ["로컬"] }]), true);
});
