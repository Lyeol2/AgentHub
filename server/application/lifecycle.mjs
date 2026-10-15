import { randomBytes } from "node:crypto";
import { AGENTS } from "../runner.mjs";
import { lastAnswer } from "../chain.mjs";
import { extractQuestions } from "../question.mjs";
import { processMessageBlocks } from "./messaging.mjs";

// One ordered pipeline owns turn completion. Preprocessing must finish before the
// chain can start queued work, because that would change the last answer.
export function createTurnLifecycle({ runner, mailbox, sessions, workflows, chain, notify }) {
  function recordQuestions(session, ok) {
    if (session.chat || !ok || AGENTS[session.agent].interactive) return;
    const found = extractQuestions(lastAnswer(session));
    if (!found) return;
    const event = {
      kind: "question", questionId: randomBytes(4).toString("hex"),
      status: "pending", text: "질문",
    };
    if (found.error) {
      event.status = "invalid";
      event.error = found.error;
    } else {
      event.questions = found.questions;
      session.waiting = true;
    }
    runner.append(session, event);
  }

  return async function onTurnEnd(session, ok) {
    processMessageBlocks(session, ok, { mailbox, runner });
    recordQuestions(session, ok);
    workflows.recordPlan(session, ok);
    // Reset the completed turn before queued work starts a new one.
    mailbox.onTurnEnd(session);
    sessions.finishHandover(session);
    notify("sessions", {});
    await chain.onTurnEnd(session, ok);
  };
}

