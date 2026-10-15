// 기존 import 경로를 위한 기본 파일 저장소 조립. 업무 처리와 순수 규칙은 독립 모듈에 둔다.
import { Mailbox as MessagingMailbox, ProjectBoard } from "./application/messaging.mjs";
import { FileMessageLog } from "./infrastructure/persistence/messages.mjs";
import { FileBoardRepository } from "./infrastructure/persistence/boards.mjs";

export { MESSAGE_GUIDE, MESSAGE_FENCE, MESSAGE_MAX, ASK_TIMEOUT_SEC, ASK_TIMEOUT_MAX, extractMessages, stripMessages, findTarget, messageText } from "./policies/messaging.mjs";
export { ProjectBoard, processMessageBlocks } from "./application/messaging.mjs";

export class Mailbox extends MessagingMailbox {
  constructor({ dataDir, messageLog = new FileMessageLog({ dataDir }), ...options }) {
    super({ ...options, messageLog });
  }
}

export const createBoardStore = ({ dataDir } = {}) => new ProjectBoard({ repository: new FileBoardRepository({ dataDir }) });
let defaultBoard;
const board = () => defaultBoard ??= createBoardStore();
export const readBoard = (projectPath) => board().read(projectPath);
export const postBoard = (projectPath, author, text) => board().post(projectPath, author, text);
export const writeBoard = (projectPath, text) => board().write(projectPath, text);
export const clearBoard = (projectPath) => board().clear(projectPath);
