declare module 'ass-parser' {
  function assParser(content: string): any[];
  export = assParser;
}

declare module 'ass-stringify' {
  function assStringify(data: any[]): string;
  export = assStringify;
}
