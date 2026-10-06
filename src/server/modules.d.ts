declare module "ass-parser" {
  namespace assParser {
    /** A Format line lists field names; Style and Dialogue lines map them; everything else is a string. */
    type AssValue = string | string[] | Record<string, string>;
    interface AssLine {
      key: string;
      value: AssValue;
    }
    interface AssSection {
      section: string;
      body: AssLine[];
    }
  }
  function assParser(content: string): assParser.AssSection[];
  export = assParser;
}

declare module "ass-stringify" {
  import type assParser = require("ass-parser");
  function assStringify(data: assParser.AssSection[]): string;
  export = assStringify;
}
