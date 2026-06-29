// Curated lowlight instance for the notebook code block. We register only the
// languages worth shipping (firmware-log workflows lean on c/cpp/python/bash/
// json/yaml) to keep the bundle lean instead of pulling in highlight.js's full
// `common` set.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";

export const lowlight = createLowlight();

lowlight.register({ bash, c, cpp, json, python });

/** Dropdown options for the code-block language picker. `value` must match a
 *  registered language name (or "plaintext" for no highlighting). */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: "plaintext", label: "Plain text" },
  { value: "bash", label: "Bash / Shell" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "python", label: "Python" },
  { value: "json", label: "JSON" },
];
