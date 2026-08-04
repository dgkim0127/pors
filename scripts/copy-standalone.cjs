const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const targetDir = path.join(root, "public");

fs.mkdirSync(targetDir, { recursive: true });
["standalone.js", "online-quotes.js"].forEach((fileName) => {
  const source = path.join(root, "src", fileName);
  const target = path.join(targetDir, fileName);
  fs.copyFileSync(source, target);
  console.log(`Copied ${path.relative(root, source)} to ${path.relative(root, target)}`);
});
