"use strict";
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
fs.mkdirSync("/fixtures", { recursive: true });
fs.writeFileSync("/fixtures/youtube-cookies.txt", `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-${randomUUID()}\n`, { mode: 0o644 });
require("/qualification/fixture.cjs");
