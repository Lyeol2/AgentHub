// 되돌리기 어려운 동작 전에 바뀌는 것과 남는 것을 요약해 보여 주는 확인 창.
// 취소하거나 Esc로 닫으면 { ok: false }를 돌려주고 호출한 쪽은 아무 요청도 보내지 않는다.
//   title: 창 제목, subject: 대상(작업 제목·PR 번호 등)
//   changes: 바뀌는 것, keeps: 그대로 남는 것, warnings: 되돌릴 수 없는 위험
//   checkbox: { label, checked } 선택 사항(예: 로컬 브랜치도 지우기)
//   confirmLabel: 실행 버튼 글자, danger: 실행 버튼을 위험 색으로
let current = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title, items, className) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const wrap = el('section', `confirm-section ${className}`);
  wrap.append(el('h4', '', title));
  const ul = el('ul');
  for (const item of list) ul.append(el('li', '', item));
  wrap.append(ul);
  return wrap;
}

export function confirmAction({ title, subject = '', changes = [], keeps = [], warnings = [], checkbox = null, confirmLabel = '확인', cancelLabel = '취소', danger = false } = {}) {
  current?.close('cancel');
  const dialog = el('dialog', 'confirm-dialog');
  dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
  const form = el('form', 'dialog-form');
  form.method = 'dialog';
  const heading = el('h3', '', title);
  heading.id = 'confirm-dialog-title';
  if (subject) heading.append(el('small', 'confirm-subject', subject));
  form.append(heading);
  for (const part of [section('바뀌는 것', changes, 'confirm-changes'), section('그대로 남는 것', keeps, 'confirm-keeps'), section('주의', warnings, 'confirm-warnings')]) {
    if (part) form.append(part);
  }
  let input = null;
  if (checkbox?.label) {
    const label = el('label', 'check confirm-option');
    input = el('input');
    input.type = 'checkbox';
    input.checked = !!checkbox.checked;
    label.append(input, el('span', '', checkbox.label));
    form.append(label);
  }
  const menu = el('menu');
  const cancel = el('button', 'ghost', cancelLabel);
  cancel.value = 'cancel';
  cancel.formNoValidate = true;
  const ok = el('button', danger ? 'primary danger' : 'primary', confirmLabel);
  ok.value = 'ok';
  ok.dataset.confirmOk = '';
  menu.append(cancel, ok);
  form.append(menu);
  dialog.append(form);
  document.body.append(dialog);
  current = dialog;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const result = { ok: dialog.returnValue === 'ok', checked: !!input?.checked };
      if (current === dialog) current = null;
      dialog.remove();
      resolve(result);
    }, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}
