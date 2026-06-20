import { test, expect } from "bun:test";
import { tatColor, filterFromTatAttrs } from "@/lib/defaults";

// --- tatColor ---------------------------------------------------------------

test("tatColor maps 6-digit hex, strips ARGB alpha, and falls back", () => {
  expect(tatColor("808000", "#000")).toBe("#808000");
  expect(tatColor("FFA500", "#000")).toBe("#ffa500"); // normalised to lowercase
  expect(tatColor("ff808000", "#000")).toBe("#808000"); // 8-digit ARGB → RGB
  expect(tatColor("#1c1f23", "#000")).toBe("#1c1f23"); // tolerates a leading #
  expect(tatColor("", "#fff7c2")).toBe("#fff7c2");
  expect(tatColor("nothex", "#fff7c2")).toBe("#fff7c2");
});

// --- filterFromTatAttrs -----------------------------------------------------

test("filterFromTatAttrs maps the y/n flags, text, and colours", () => {
  const f = filterFromTatAttrs({
    text: "littlefs mount ok",
    description: "boot",
    enabled: "y",
    excluding: "n",
    case_sensitive: "n",
    regex: "y",
    foreColor: "808000",
    backColor: "ffa500",
  });
  expect(f.pattern).toBe("littlefs mount ok");
  expect(f.description).toBe("boot");
  expect(f.enabled).toBe(true);
  expect(f.exclude).toBe(false);
  expect(f.caseSensitive).toBe(false);
  expect(f.regex).toBe(true);
  expect(f.textColor).toBe("#808000");
  expect(f.bgColor).toBe("#ffa500");
});

test("filterFromTatAttrs honours excluding=y, disabled, and case_sensitive=y", () => {
  const f = filterFromTatAttrs({
    text: "ERR",
    enabled: "n",
    excluding: "y",
    case_sensitive: "y",
  });
  expect(f.enabled).toBe(false);
  expect(f.exclude).toBe(true);
  expect(f.caseSensitive).toBe(true);
});

test("filterFromTatAttrs uses our defaults for missing colours / text", () => {
  const f = filterFromTatAttrs({});
  expect(f.pattern).toBe("");
  expect(f.textColor).toBe("#1c1f23");
  expect(f.bgColor).toBe("#ffffff");
  expect(f.enabled).toBe(false); // a missing enabled attr is treated as not "y"
});
