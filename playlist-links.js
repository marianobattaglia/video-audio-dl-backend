(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MediaLinks = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
  const identifier = /^[A-Za-z0-9_-]{1,128}$/;
  function classify(value) {
    let url;
    try { url = new URL(value); } catch { return { type: "invalid" }; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.port && !["80", "443"].includes(url.port)) return { type: "invalid" };
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") {
      const video = url.pathname.slice(1).split("/")[0];
      if (!identifier.test(video)) return { type: "unsupported" };
      return { type: "individual", url: `${url.protocol}//youtu.be/${video}`, videoId: video };
    }
    if (!hosts.has(host)) return { type: "individual", url: url.href };
    // The extractor still validates individual IDs. This preserves existing
    // single-source behavior; playlist metadata IDs are checked strictly later.
    let video = url.pathname === "/watch" ? url.searchParams.get("v") : null;
    if (!video) video = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    if (video && identifier.test(video) && video !== "videoseries") {
      return { type: "individual", url: `${url.protocol}//${host}/watch?v=${video}`, videoId: video };
    }
    const list = url.searchParams.get("list");
    if (["/playlist", "/watch", "/embed/videoseries"].includes(url.pathname) && identifier.test(list || "")) {
      if (url.protocol !== "https:" || list.startsWith("RD")) return { type: "unsupported" };
      return { type: "playlist", url: `https://${host}/playlist?list=${list}`, host, listId: list };
    }
    return { type: "unsupported" };
  }
  return { classify };
});
