import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../../test-render";
import { CorrectionsSection } from "./CorrectionsSection";

const ignore = async () => "saved";

test("no rule sets: the section explains itself and offers to add one", () => {
  const page = renderPage(<CorrectionsSection settings={{ correction_rule_sets: "[]" }} updateAndSave={ignore} />);
  assert.ok(page.text.includes("No correction lists yet."));
  assert.ok(page.buttons.includes("New list"));
});

test("a saved set shows its folders and rules", () => {
  const sets = [
    {
      id: "sereniti",
      name: "Sereniti",
      enabled: true,
      paths: ["AnKor"],
      rules: [{ id: "r1", find: "Serenity", replace: "Sereniti", stage: "source", match: "word" }],
    },
  ];
  const page = renderPage(
    <CorrectionsSection settings={{ correction_rule_sets: JSON.stringify(sets) }} updateAndSave={ignore} />,
  );
  assert.ok(page.text.includes("AnKor"));
  assert.ok(page.html.includes('value="Serenity"'));
  assert.ok(page.html.includes('value="Sereniti"'));
  assert.ok(page.buttons.includes("Add rule"));
});
