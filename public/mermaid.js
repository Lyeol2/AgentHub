// Load bundled renderers only when a completed Mermaid block is displayed.
let renderer;
let sequence = 0;
function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(path, import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error("renderer unavailable")); };
    document.head.append(script);
  });
}
function loadRenderer() {
  return renderer ??= Promise.all([
    loadScript("./vendor/mermaid/mermaid.min.js"),
    loadScript("./vendor/dompurify/purify.min.js"),
  ]).then(() => {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false, look: "classic",
      suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500,
      flowchart: { htmlLabels: false },
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "themeCSS", "htmlLabels", "look"] });
    return window.mermaid;
  }).catch((error) => { renderer = undefined; throw error; });
}

if (typeof customElements !== "undefined" && !customElements.get("mermaid-diagram")) {
  customElements.define("mermaid-diagram", class extends HTMLElement {
    connectedCallback() {
      if (this.started) return;
      this.started = true;
      // The parser may still be inserting the escaped code child.
      queueMicrotask(() => this.render());
    }
    async render() {
      const source = this.querySelector("code")?.textContent ?? "";
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        :host{display:block;margin:12px 0;min-width:0} .diagram{overflow:auto;background:#fff;border-radius:8px;padding:12px;color:#222}
        .diagram svg{display:block;max-width:none!important;margin:auto} .status,summary{font:13px system-ui}summary{cursor:pointer;padding:8px 0}
        pre{white-space:pre;overflow:auto;font:12px monospace}button{cursor:pointer;margin-bottom:8px}
      </style><div class="status" role="status">다이어그램을 그리는 중…</div><div class="diagram" hidden></div><details><summary>Mermaid 원문</summary><pre></pre></details>`;
      root.querySelector("pre").textContent = source;
      const status = root.querySelector(".status"), diagram = root.querySelector(".diagram");
      try {
        if (source.length > 50000) throw new Error("diagram too large");
        // Reject resource-bearing syntax before Mermaid can measure/load external images.
        if (/\bimg\s*:|!\[|<\s*(?:img|image|iframe|object)\b|url\s*\(/i.test(source)) throw new Error("external resources disabled");
        const mermaid = await loadRenderer();
        if (!this.isConnected) return;
        // Mermaid measures text in the document; render there, then isolate its SVG styles in the shadow root.
        const { svg } = await mermaid.render(`agenthub-mermaid-${++sequence}`, source);
        if (!this.isConnected) return;
        diagram.innerHTML = window.DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ["foreignObject", "image", "a", "script"] });
        const graphic = diagram.querySelector("svg");
        if (!graphic) throw new Error("empty diagram");
        graphic.setAttribute("role", "img");
        graphic.setAttribute("aria-label", "Mermaid 다이어그램");
        const width = graphic.viewBox.baseVal.width;
        if (width > 0) graphic.style.width = `${Math.min(2400, Math.max(200, width))}px`;
        diagram.hidden = false;
        status.textContent = "";
      } catch {
        status.textContent = "다이어그램을 표시하지 못했습니다. Mermaid 원문을 확인해 주세요.";
        root.querySelector("details").open = true;
      }
    }
  });
}
