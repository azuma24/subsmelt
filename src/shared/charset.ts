/**
 * Decoding subtitle files whose encoding nobody wrote down. Most are UTF-8;
 * the rest are the legacy code pages subtitle sites handed out for decades:
 * GBK and Big5 for Chinese, Shift_JIS and EUC-JP for Japanese, EUC-KR for
 * Korean, and the windows-125x family for everything written in Latin,
 * Cyrillic, Greek, Hebrew, Arabic or Thai letters.
 *
 * The order is: a byte-order mark decides; else strict UTF-8; else every
 * candidate encoding decodes a sample and the one whose output looks most
 * like text in its own script wins. "Looks like text" is cheap to judge:
 * Japanese has kana, Korean has hangul, Chinese in the right encoding is
 * full of the few hundred characters every text uses, and Latin-script
 * text in the right code page uses the letters of one language rather than
 * symbols, control characters or a different alphabet in every word.
 *
 * Runs on the TextDecoder both the browser and Node ship (Node needs the
 * full ICU its official builds carry). A decoder that is missing just takes
 * its candidate out of the running.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** How many bytes the detector reads; subtitle files are small and the start says everything. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * Labels the WHATWG Encoding Standard maps to windows-1252. Browsers decode
 * them with the windows-1252 table, but Node's TextDecoder takes a latin1
 * fast path for the same labels and leaves 0x80–0x9F as C1 control
 * characters (an em dash becomes U+0097). Decoding this family by hand keeps
 * the output identical in every runtime.
 */
const WINDOWS_1252_LABELS = new Set([
  "windows-1252",
  "cp1252",
  "x-cp1252",
  "ansi_x3.4-1968",
  "ascii",
  "us-ascii",
  "iso-8859-1",
  "iso8859-1",
  "iso88591",
  "iso_8859-1",
  "iso_8859-1:1987",
  "latin1",
  "l1",
  "cp819",
  "ibm819",
  "csisolatin1",
  "iso-ir-100",
]);

/** Code points for bytes 0x80–0x9F in windows-1252; undefined bytes keep their C1 value. */
const WINDOWS_1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    units[i] = b >= 0x80 && b <= 0x9f ? WINDOWS_1252_C1[b - 0x80] : b;
  }
  let out = "";
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, i + 8192));
  }
  return out;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

/** `bytes` in the named encoding, or null when the runtime has no such decoder or, with `fatal`, the bytes do not fit it. */
export function decodeWithLabel(bytes: Uint8Array, label: string, fatal = false): string | null {
  const lower = label.toLowerCase();
  if (WINDOWS_1252_LABELS.has(lower)) return decodeWindows1252(bytes);
  try {
    return new TextDecoder(lower, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * The few hundred characters most Chinese text is made of, in each script.
 * A decoding in the right encoding hits them constantly; the same bytes read
 * in the other encoding come out as rare characters that hit neither list.
 */
const COMMON_SIMPLIFIED =
  "的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吃危角";
const COMMON_TRADITIONAL =
  "的一是不了在人有我他這個們中來上大為和國地到以說時要就出會可也你對生能而子那得於著下自之年過發後作裡用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實日軍者意無力它與長把機十民第公此已工使情明性知全三又關點正業外將兩高間由問很最重並物手應戰向頭文體政美相見被利什二等產或新己制身果加西斯月話合回特代內信表化老給世位次度門任常先海通教兒原東聲提立及比員解水名真論處走義各入幾口認條平系氣題活爾更別打女變四神總何電數安少報才結反受目太量再感建務做接必場件計管期市直德資命山金指克許統區保至隊形社便空決治展馬科司五基眼書非則聽白卻界達光放強即像難且權思王象完設式色路記南品住告類求據程北邊死張該交規萬取拉格望覺術領共確傳師觀清今切院讓識候帶導爭運笑飛風步改收根幹造言聯持組每濟車親極林服快辦議往元英士證近失轉夫令準布始怎呢存未遠叫台單影具羅字愛擊流備兵連調深商算質團集百需價花黨華城石級整府離況亞請技際約示複病息究線似官火斷精滿支視消越器容照須九增研寫稱企八功吃危角";
const SIMPLIFIED = new Set(COMMON_SIMPLIFIED);
const TRADITIONAL = new Set(COMMON_TRADITIONAL);

type Script =
  | "cjk-simplified"
  | "cjk-traditional"
  | "japanese"
  | "korean"
  | "latin"
  | "cyrillic"
  | "greek"
  | "hebrew"
  | "arabic"
  | "thai";

interface Candidate {
  label: string;
  script: Script;
  /** Multi-byte encodings must decode without error; a single-byte page always decodes. */
  multibyte: boolean;
}

/** In order of preference when scores tie. */
const CANDIDATES: Candidate[] = [
  { label: "gb18030", script: "cjk-simplified", multibyte: true },
  { label: "big5", script: "cjk-traditional", multibyte: true },
  { label: "shift_jis", script: "japanese", multibyte: true },
  { label: "euc-jp", script: "japanese", multibyte: true },
  { label: "euc-kr", script: "korean", multibyte: true },
  { label: "windows-1252", script: "latin", multibyte: false },
  { label: "windows-1250", script: "latin", multibyte: false },
  { label: "iso-8859-2", script: "latin", multibyte: false },
  { label: "windows-1254", script: "latin", multibyte: false },
  { label: "windows-1257", script: "latin", multibyte: false },
  { label: "windows-1251", script: "cyrillic", multibyte: false },
  { label: "koi8-r", script: "cyrillic", multibyte: false },
  { label: "koi8-u", script: "cyrillic", multibyte: false },
  { label: "windows-1253", script: "greek", multibyte: false },
  { label: "windows-1255", script: "hebrew", multibyte: false },
  { label: "windows-1256", script: "arabic", multibyte: false },
  { label: "windows-874", script: "thai", multibyte: false },
];

/**
 * The letters beyond ASCII each Latin-script language writes with. A code
 * page's decoding is judged by the language it fits best: the right page
 * makes every accented letter belong to one language, the wrong page makes
 * a jumble no language uses.
 */
const LATIN_LANGUAGES: Set<string>[] = [
  "àâæçéèêëîïôœùûüÿ", // French
  "äöüß", // German
  "áéíóúñü¿¡", // Spanish
  "ãõáéíóúâêôàç", // Portuguese
  "àèéìíòóù", // Italian
  "éëïöü", // Dutch
  "æøå", // Danish, Norwegian
  "åäö", // Swedish, Finnish
  "áðéíóúýþæö", // Icelandic
  "çğıöşüİ", // Turkish
  "ąćęłńóśźż", // Polish
  "áčďéěíňóřšťúůýž", // Czech
  "áäčďéíĺľňóôŕšťúýž", // Slovak
  "áéíóöőúüű", // Hungarian
  "čćđšž", // Croatian, Slovenian, Bosnian
  "ăâîșşțţ", // Romanian
  "ąčęėįšųūž", // Lithuanian
  "āčēģīķļņšūž", // Latvian
  "äöõüšž", // Estonian
  "àéèíïòóúüç", // Catalan
].map((letters) => new Set(letters + letters.toUpperCase()));

/** Typography any code page may legitimately produce in a subtitle; neither a letter nor a symptom. */
const NEUTRAL = new Set(" ­«»¿¡°·€£¥§©®™´¨¸¯–—‘’‚“”„…‹›•");

const LETTER = /[\p{L}\p{M}]/u;
const WORD = /[\p{L}\p{M}]+/gu;

/**
 * The words every text in these alphabets is full of. A code page read in
 * the wrong alphabet produces letters, but never these words.
 */
const COMMON_WORDS: Partial<Record<Script, Set<string>>> = {
  cyrillic: new Set(
    "и в не на что я ты это он она но как так с а мы вы да нет ну же все его её у из за по то где когда если вот только меня тебя сейчас хорошо почему і що це ти він вона ми ви ні але як з до є та був була това той тя ние вие така със".split(
      " ",
    ),
  ),
  greek: new Set(
    "και να το η ο τι δεν είναι θα με σε για που από την τον μου σου του της αυτό εδώ τώρα όχι ναι τα οι στο στη έχει ήταν".split(
      " ",
    ),
  ),
  hebrew: new Set(
    "את של על לא זה אני הוא היא מה יש אם כל כן גם או אבל רק עם אתה הם אנחנו לי לך כאן עכשיו היה אל".split(" "),
  ),
  arabic: new Set(
    "في من على أن لا ما هذا هذه إلى عن أنا أنت هو هي نحن هل لم لن كان كل مع هنا الآن نعم أو و يا ذلك".split(" "),
  ),
};

/** Alphabets with spaces between words, where a very long "word" means the bytes are not this alphabet. */
const SPACED: ReadonlySet<Script> = new Set(["latin", "cyrillic", "greek", "hebrew", "arabic", "korean"]);

/** The syllables most Korean words end in: particles and verb endings. Bytes read as random hangul end anywhere. */
const KOREAN_ENDINGS = new Set("은는이가을를의에도로다요고서지까네죠만와과서게");
/** The hundred-odd syllables that make up most Korean text; EUC-KR can spell 2,350, and random bytes use them all. */
const COMMON_HANGUL = new Set(
  "이다는에를가고하지의은을로어한기사아있나수그으도서자리게대니요시인주들라상정제거면부일까생무전보러원소공발여해동우적성운내않였되마었세문화간학호야점과데국년저장신경중안미조음만개물비금식체알재말명방당실될없습니께겠던록께서처럼큼것",
);
/** Hebrew letters that take a final form: at the end of a word in real text, never in the middle. */
const HEBREW_FINALS = new Set("ךםןףץ");
const HEBREW_PREFIXES = new Set("הובלמשכ");

function inRange(code: number, from: number, to: number): boolean {
  return code >= from && code <= to;
}

function scriptOf(code: number): Script | "cjk" | "kana-half" | "other" {
  if (inRange(code, 0x3040, 0x30ff)) return "japanese";
  if (inRange(code, 0xff66, 0xff9f)) return "kana-half";
  if (inRange(code, 0xac00, 0xd7a3) || inRange(code, 0x1100, 0x11ff) || inRange(code, 0x3130, 0x318f)) return "korean";
  if (inRange(code, 0x4e00, 0x9fff)) return "cjk";
  if (inRange(code, 0x0400, 0x04ff)) return "cyrillic";
  if (inRange(code, 0x0370, 0x03ff)) return "greek";
  if (inRange(code, 0x0590, 0x05ff)) return "hebrew";
  if (inRange(code, 0x0600, 0x06ff)) return "arabic";
  if (inRange(code, 0x0e00, 0x0e7f)) return "thai";
  if (inRange(code, 0x00c0, 0x024f) || inRange(code, 0x1e00, 0x1eff)) return "latin";
  return "other";
}

const isThaiMark = (code: number) => code === 0x0e31 || inRange(code, 0x0e34, 0x0e3a) || inRange(code, 0x0e47, 0x0e4e);
const isThaiBase = (code: number) => inRange(code, 0x0e01, 0x0e30) || code === 0x0e32 || code === 0x0e33;
const isAsciiLetter = (code: number) => inRange(code, 0x41, 0x5a) || inRange(code, 0x61, 0x7a);
const isCjk = (code: number) => inRange(code, 0x4e00, 0x9fff);

/** A character that should never appear in text: a control, a replacement character, or a private-use or compatibility code point. */
function isNoise(code: number): boolean {
  return (
    code === 0xfffd ||
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    inRange(code, 0x7f, 0x9f) ||
    inRange(code, 0xe000, 0xf8ff) ||
    inRange(code, 0xf900, 0xfaff) ||
    inRange(code, 0x3400, 0x4dbf)
  );
}

/** How much `text` looks like text in `candidate`'s own script; higher is better, negative is "not this". */
function scoreDecoded(text: string, candidate: Candidate): number {
  let score = 0;
  let home = 0;
  let foreign = 0;
  let ascii = 0;
  let lower = 0;
  let upper = 0;
  let neutral = 0;
  const accented: string[] = [];
  const codes = Array.from(text, (char) => char.codePointAt(0) ?? 0);

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const char = String.fromCodePoint(code);
    if (code < 0x80) {
      if (isAsciiLetter(code)) ascii++;
      continue;
    }
    if (isNoise(code)) {
      score -= 4;
      continue;
    }
    if (NEUTRAL.has(char)) {
      neutral++;
      continue;
    }
    const script = scriptOf(code);
    if (!LETTER.test(char)) {
      // Fullwidth punctuation is what a CJK sentence ends with, in the right encoding.
      if (inRange(code, 0x3000, 0x303f) || inRange(code, 0xff00, 0xff65)) {
        if (candidate.multibyte) score += 2;
        continue;
      }
      score -= 1;
      continue;
    }
    switch (candidate.script) {
      case "cjk-simplified":
      case "cjk-traditional":
        if (script === "cjk") {
          home++;
          const simplified = SIMPLIFIED.has(char);
          const traditional = TRADITIONAL.has(char);
          // Two bytes per character, so each counts double against a single-byte page's letters.
          if (candidate.script === "cjk-simplified") score += simplified ? 6 : traditional ? 4 : 2;
          else score += traditional ? 6 : simplified ? 0 : 2;
        } else if (script === "japanese" || script === "kana-half") score -= 2;
        else foreign++;
        break;
      case "japanese":
        if (script === "japanese") {
          home++;
          score += 6;
        } else if (script === "cjk") {
          home++;
          score += SIMPLIFIED.has(char) || TRADITIONAL.has(char) ? 4 : 2;
        } else if (script === "kana-half") {
          // Half-width katakana is what random bytes read as Shift_JIS turn into; real subtitles use the full-width forms.
          home++;
        } else foreign++;
        break;
      case "korean":
        if (script === "korean") {
          home++;
          score += COMMON_HANGUL.has(char) ? 6 : 3;
        } else if (script === "cjk") score += 2;
        else foreign++;
        break;
      case "latin":
        if (script === "latin") {
          home++;
          accented.push(char);
        } else foreign++;
        break;
      default:
        if (script === candidate.script) {
          home++;
          score += 2;
          if (char === char.toLowerCase() && char !== char.toUpperCase()) lower++;
          else if (char === char.toUpperCase() && char !== char.toLowerCase()) upper++;
          // A Thai vowel or tone mark sits on a consonant; one after a space,
          // another mark or nothing is what random bytes read as Thai produce.
          if (candidate.script === "thai" && isThaiMark(code) && !isThaiBase(codes[i - 1] ?? 0)) score -= 5;
        } else foreign++;
    }
    // A lone CJK character wedged between ASCII letters is a Latin page's
    // accented letter read as the first byte of a pair; CJK text comes in runs.
    if (candidate.multibyte && isCjk(code) && isAsciiLetter(codes[i - 1] ?? 0) && isAsciiLetter(codes[i + 1] ?? 0))
      score -= 6;
  }

  score -= foreign * 3;
  // Typography is fine in moderation; a page where every tenth character is a dagger or a per-mille sign is byte soup.
  if (neutral > (home + ascii) * 0.1) score -= neutral;

  if (candidate.script === "latin" && accented.length > 0) {
    // The language whose alphabet covers the accented letters best; letters
    // outside it count against the page.
    let best = Number.NEGATIVE_INFINITY;
    for (const alphabet of LATIN_LANGUAGES) {
      let hits = 0;
      for (const char of accented) if (alphabet.has(char)) hits++;
      best = Math.max(best, hits * 2 - (accented.length - hits) * 2);
    }
    score += best;
  } else if (!candidate.multibyte && candidate.script !== "latin" && lower + upper > 0) {
    // Of two pages for the same alphabet (koi8-r and windows-1251 swap the
    // cases), the one that reads as mostly lower-case is the one a subtitle
    // was written in. Worth more the more letters say so.
    score += Math.round(((lower - upper) / (lower + upper)) * Math.min(4, (lower + upper) / 4));
  }

  if (!SPACED.has(candidate.script)) return score;

  const common = COMMON_WORDS[candidate.script];
  for (const word of text.match(WORD) ?? []) {
    // Nothing anyone writes is seventeen letters long twice a line; bytes of a
    // script without spaces (Chinese, Japanese, Thai) read as an alphabet are.
    if (word.length > 16) {
      score -= 6;
      continue;
    }
    const first = word.codePointAt(0) ?? 0;
    const last = word.codePointAt(word.length - 1) ?? 0;
    switch (candidate.script) {
      case "latin":
        // Words made only of accented letters are another alphabet's text read as Latin.
        if (word.length >= 3 && !/[A-Za-z]/.test(word) && /^[À-ɏ]+$/u.test(word)) score -= 3;
        break;
      case "korean":
        // Korean words run one to six syllables; a Chinese sentence read as hangul runs to the next comma.
        if (word.length > 8) score -= 6;
        else if (scriptOf(last) === "korean" && KOREAN_ENDINGS.has(word[word.length - 1])) score += 3;
        break;
      default: {
        // No alphabet mixes its letters with Latin ones inside a word.
        const mixed =
          /[A-Za-z]/.test(word) &&
          Array.from(word).some((char) => scriptOf(char.codePointAt(0) ?? 0) === candidate.script);
        if (mixed) score -= 4;
        if (common?.has(word.toLowerCase())) score += 4;
        if (candidate.script === "hebrew") {
          // Final-form letters end words and never sit inside one; most words start with a prefix letter.
          for (const char of word.slice(0, -1)) if (HEBREW_FINALS.has(char)) score -= 4;
          if (HEBREW_FINALS.has(word[word.length - 1])) score += 3;
          if (word.length >= 3 && HEBREW_PREFIXES.has(word[0])) score += 1;
        } else if (candidate.script === "arabic") {
          if (word.startsWith("ال") && word.length >= 4) score += 3;
        } else if (candidate.script === "greek") {
          // A final sigma only ends a word.
          for (const char of word.slice(0, -1)) if (char === "ς") score -= 4;
          if (word.endsWith("ς")) score += 3;
        }
        if (first === 0 && last === 0) break;
      }
    }
  }
  return score;
}

/**
 * The encoding bytes that are not UTF-8 were most likely written in, as a
 * TextDecoder label. Callers rule out UTF-8 first; for anything else the
 * best candidate beats replacement characters, so there is no "unsure".
 */
export function detectLegacyEncoding(bytes: Uint8Array): string {
  const sample = bytes.length > SAMPLE_BYTES ? bytes.subarray(0, SAMPLE_BYTES) : bytes;
  let bestLabel = "windows-1252";
  let bestScore = -Infinity;
  for (const candidate of CANDIDATES) {
    const text = decodeWithLabel(sample, candidate.label, candidate.multibyte);
    if (text === null) continue;
    const score = scoreDecoded(text, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = candidate.label;
    }
  }
  return bestLabel;
}

/**
 * Subtitle bytes as text: a byte-order mark decides, valid UTF-8 is UTF-8,
 * anything else is decoded as the legacy encoding it fits best. Never throws;
 * the last resort is UTF-8 with replacement characters.
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (hasPrefix(bytes, UTF8_BOM)) return new TextDecoder("utf-8").decode(bytes);
  if (hasPrefix(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes);
  if (hasPrefix(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes);
  const utf8 = decodeWithLabel(bytes, "utf-8", true);
  if (utf8 !== null) return utf8;
  return decodeWithLabel(bytes, detectLegacyEncoding(bytes)) ?? new TextDecoder("utf-8").decode(bytes);
}
