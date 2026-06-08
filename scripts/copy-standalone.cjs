const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "standalone.js");
const targetDir = path.join(root, "public");
const target = path.join(targetDir, "standalone.js");

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied ${path.relative(root, source)} to ${path.relative(root, target)}`);
