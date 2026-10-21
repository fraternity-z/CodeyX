(() => {
  if (
    !/\/index\.html$/i.test(location.pathname) ||
    new URLSearchParams(location.search).has("initialRoute")
  ) return;
  const markup = __CODEY_STARTUP_SPLASH__;
  const install = () => {
    if (document.querySelector(".codey-splash")) return true;
    const root = document.getElementById("root");
    if (!root) return document.readyState !== "loading";
    if (!root.querySelector(":scope > .startup-loader")) {
      return document.readyState !== "loading" || root.childElementCount > 0;
    }
    if (root.parentElement !== document.body) return true;
    const template = document.createElement("template");
    template.innerHTML = markup;
    root.before(template.content);
    return true;
  };
  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      observer.disconnect();
      install();
    },
    { once: true },
  );
})();
