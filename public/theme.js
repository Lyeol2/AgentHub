// 화면 테마: dark | light | system. 첫 화면이 깜빡이지 않도록 CSS를 그리기 전에 적용한다.
(() => {
  const KEY = "agenthub.theme";
  const media = matchMedia("(prefers-color-scheme: light)");
  const read = () => {
    try {
      return localStorage.getItem(KEY) || "dark";
    } catch {
      return "dark";
    }
  };
  let pref = read();
  const apply = () => {
    document.documentElement.dataset.theme = pref === "system" ? (media.matches ? "light" : "dark") : pref;
    dispatchEvent(new CustomEvent("agenthub-theme", { detail: pref }));
  };
  window.agenthubTheme = {
    get: () => pref,
    set(next) {
      pref = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // 저장하지 못해도 이번 화면에는 적용한다.
      }
      apply();
    },
  };
  apply();
  media.addEventListener("change", apply);
  // 다른 창(별도 채팅 창 등)에서 바꾸면 따라간다.
  addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    pref = read();
    apply();
  });
})();
