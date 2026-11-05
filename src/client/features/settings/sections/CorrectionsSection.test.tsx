import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../../test-render";
import { CorrectionsSection } from "./CorrectionsSection";

const ignore = () => {};

test("no rule sets: the section explains itself and offers to add one", () => {
  const page = renderPage(<CorrectionsSection settings={{ correction_rule_sets: "[]" }} updateAndSave={ignore} />);
  assert.ok(page.text.includes("No rule sets yet."));
  assert.ok(page.buttons.includes("Add rule set"));
});

test("a saved set shows its folders and rules", () => {
  const sets = [
    {
      id: "ubnt",
      name: "Ubiquiti",
      enabled: true,
      paths: ["UniFi"],
      rules: [{ id: "r1", find: "Ubiquity", replace: "Ubiquiti", stage: "source", match: "word" }],
    },
  ];
  const page = renderPage(
    <CorrectionsSection settings={{ correction_rule_sets: JSON.stringify(sets) }} updateAndSave={ignore} />,
  );
  assert.ok(page.text.includes("UniFi"));
  assert.ok(page.html.includes('value="Ubiquity"'));
  assert.ok(page.html.includes('value="Ubiquiti"'));
  assert.ok(page.buttons.includes("Add rule"));
});
