import React from "react";

export function Icon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true
  };
  const paths = {
    plus: [React.createElement("path", { key: "a", d: "M12 5v14" }), React.createElement("path", { key: "b", d: "M5 12h14" })],
    minus: [React.createElement("path", { key: "a", d: "M5 12h14" })],
    trash: [
      React.createElement("path", { key: "a", d: "M3 6h18" }),
      React.createElement("path", { key: "b", d: "M8 6V4h8v2" }),
      React.createElement("path", { key: "c", d: "M6 6l1 15h10l1-15" })
    ],
    print: [
      React.createElement("path", { key: "a", d: "M6 9V3h12v6" }),
      React.createElement("path", { key: "b", d: "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" }),
      React.createElement("path", { key: "c", d: "M6 14h12v7H6z" })
    ],
    search: [
      React.createElement("circle", { key: "a", cx: 11, cy: 11, r: 7 }),
      React.createElement("path", { key: "b", d: "M21 21l-4.3-4.3" })
    ],
    save: [
      React.createElement("path", { key: "a", d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" }),
      React.createElement("path", { key: "b", d: "M17 21v-8H7v8" }),
      React.createElement("path", { key: "c", d: "M7 3v5h8" })
    ],
    settings: [
      React.createElement("circle", { key: "a", cx: 12, cy: 12, r: 3 }),
      React.createElement("path", { key: "b", d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 2-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-3v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2-2 .1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4v-3h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-2 .1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h3v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2 2-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v3h-.1a1.7 1.7 0 0 0-1.5 1z" })
    ]
  };
  return React.createElement("svg", common, paths[name] || paths.plus);
}
