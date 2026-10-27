/**
 * A PDF's streams measured before pdf.js reads it (document checks DK3,
 * docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md). pdf.js decodes a stream into a buffer outside
 * any JavaScript heap, so no heap limit counts it, and a file of a few hundred kilobytes can deflate to gigabytes. Here,
 * every stream pdf.js would decode to read the file's text is decoded first, the way pdf.js decodes it, only counting
 * its bytes where nothing needs them, against one budget for the whole file. A file over it is refused having decoded
 * no more than the budget, in a fraction of a second, and pdf.js never sees it.
 *
 * What is measured, and how:
 * - Every object after an `obj` keyword is read with pdf.js's own grammar (its lexer and parser, ported below), so a
 *   filter is found however its dictionary writes it: `/FlateDecode` or `/Fl`, a name with `#` escapes, `/F`, which
 *   pdf.js reads before `/Filter`, or another object. A `stream` keyword no object led to is inflated as though its
 *   filter were FlateDecode.
 * - FlateDecode is inflated with a port of pdf.js's own decoder, not zlib: pdf.js decodes streams zlib refuses (a copy
 *   from before the stream's start, an incomplete code table), which would otherwise pass unmeasured. ASCIIHexDecode and
 *   ASCII85Decode are ported too. Each step of a chain counts, since pdf.js holds each step's buffer. A stream is read
 *   from its start to the end of the file, never to the length its dictionary claims: a decoder stops where its own
 *   data ends, so this is at least what pdf.js decodes, whatever length it uses.
 * - Image XObjects and embedded files are left out: pdf.js never decodes them to read text. A stream named an image is
 *   counted all the same when a page's contents, a font or a character map name it, from any object read, including
 *   the ones inside object streams, which are decoded first.
 * - A stream read for text whose filter cannot be measured (LZW, run-length, Brotli, an image codec, or a filter kept
 *   in an object not found) is skipped, and an encrypted file's streams are measured as written; each such file is
 *   refused too, and says why, once every other stream is measured under the budget. So a file past the budget is
 *   refused as that, wherever those streams sit. One of more streams or work than the limits is refused at once. The
 *   cycle reads no refused file, and `readDocument` reads all but the one past the budget in a worker, under its limits
 *   (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB1, RB6). There is no mode that lets them through.
 *
 * What it does not bound: how often pdf.js decodes one stream (a form drawn by many forms), predictors, which never
 * make a stream larger, or a stream it could not find. The worker's process memory budget bounds the rest
 * (./pdf-worker.ts).
 */

export interface PrescanLimits {
  /** The most bytes the file's streams may decode to, all together. */
  maxDecodedBytes: number;
  /** The most streams looked at. */
  maxStreams: number;
  /** The most bytes the scan may read through, decoders and object reader together, and table entries it may build. */
  maxWorkBytes: number;
}

/** The limits both read paths scan with. The test fixtures and every invoice tried decode to well under a megabyte. */
export const PRESCAN_LIMITS: Readonly<PrescanLimits> = { maxDecodedBytes: 16 * 2 ** 20, maxStreams: 10_000, maxWorkBytes: 64 * 2 ** 20 };

/** Why a file is refused: it decodes past the budget; a stream read for text cannot be measured; it is encrypted; or it is more than the scan takes on. */
export type PrescanRefusal = "decoded_limit" | "unbounded_filter" | "encrypted" | "too_complex";

export interface Prescan {
  refused: PrescanRefusal | null;
  /** What the streams measured decode to, in bytes, as far as the scan went. */
  decodedBytes: number;
}

// ------------------------------------------------------------------------------------------------ pdf.js's grammar

const WHITE = 1;
const DELIMITER = 2;
/** pdf.js's character classes: whitespace, delimiters, and everything else, which makes up names, numbers and keywords. */
const CLASS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) CLASS[code] = WHITE;
for (const code of [37, 40, 41, 47, 60, 62, 91, 93, 123, 125]) CLASS[code] = DELIMITER;
const classOf = (code: number) => (code < 0 ? WHITE : CLASS[code]);
/** pdf.js's `isWhiteSpace`, narrower than its lexer's whitespace. */
const isWhiteSpace = (code: number) => code === 32 || code === 9 || code === 13 || code === 10;
const isDigit = (code: number) => code >= 48 && code <= 57;
function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code & 15;
  if ((code >= 65 && code <= 70) || (code >= 97 && code <= 102)) return (code & 15) + 9;
  return -1;
}

class Name {
  constructor(readonly name: string) {}
}
class Cmd {
  constructor(readonly cmd: string) {}
}
class Ref {
  constructor(
    readonly num: number,
    readonly gen: number
  ) {}
}
class Dict {
  readonly map = new Map<string, Value>();
  /** pdf.js's `Dict.get(key1, key2)`: the first key's value when it has one. */
  get(key: string, alias?: string): Value | undefined {
    const value = this.map.get(key);
    return value === undefined && alias !== undefined ? this.map.get(alias) : value;
  }
}
/** A dictionary followed by `stream`: where its data begins, as pdf.js's parser finds it. */
class StreamStart {
  constructor(
    readonly dict: Dict,
    readonly dataStart: number
  ) {}
}
const STRING = Symbol("string");
const EOF = Symbol("eof");
type Value = number | boolean | null | Name | Cmd | Ref | Dict | StreamStart | Value[] | typeof STRING | typeof EOF;

/** pdf.js would stop on this too, or the read went past its own bounds: the object is left unread. */
class Unreadable extends Error {}
/** The scan's own limits, or the file's refusal. */
class Refused extends Error {
  constructor(readonly why: PrescanRefusal) {
    super(why);
  }
}

/** Where the char after `stream` is: data begins after the end of that line, as pdf.js's `skipToNextLine` has it. */
function dataStartAfter(bytes: Uint8Array, at: number): number {
  for (let i = at; i < bytes.length; i++) {
    if (bytes[i] === 13) return bytes[i + 1] === 10 ? i + 2 : i + 1;
    if (bytes[i] === 10) return i + 1;
  }
  return bytes.length;
}

/** pdf.js's Lexer, over `bytes` from `start` to `end`, with its quirks. Strings and hex strings are skipped, not kept. */
class Lexer {
  private pos: number;
  current = -1;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    private readonly end: number
  ) {
    this.pos = start;
    this.nextChar();
  }
  /** How far it has read. */
  get read(): number {
    return this.pos - this.start;
  }
  /** The index of `current`, the char after the last token. */
  get at(): number {
    return this.current === -1 ? this.pos : this.pos - 1;
  }
  private nextChar(): number {
    this.current = this.pos < this.end ? this.bytes[this.pos++] : -1;
    return this.current;
  }
  private peekChar(): number {
    return this.pos < this.end ? this.bytes[this.pos] : -1;
  }

  token(): Value {
    let comment = false;
    let ch = this.current;
    for (;;) {
      if (ch < 0) return EOF;
      if (comment) {
        if (ch === 10 || ch === 13) comment = false;
      } else if (ch === 37) comment = true;
      else if (classOf(ch) !== WHITE) break;
      ch = this.nextChar();
    }
    if (isDigit(ch) || ch === 43 || ch === 45 || ch === 46) return this.number();
    switch (ch) {
      case 40:
        return this.string();
      case 47:
        return this.name();
      case 91:
        this.nextChar();
        return new Cmd("[");
      case 93:
        this.nextChar();
        return new Cmd("]");
      case 60:
        ch = this.nextChar();
        if (ch === 60) {
          this.nextChar();
          return new Cmd("<<");
        }
        return this.hexString();
      case 62:
        ch = this.nextChar();
        if (ch === 62) {
          this.nextChar();
          return new Cmd(">>");
        }
        return new Cmd(">");
      case 123:
        this.nextChar();
        return new Cmd("{");
      case 125:
        this.nextChar();
        return new Cmd("}");
      case 41:
        throw new Unreadable("an illegal character");
    }
    let word = String.fromCharCode(ch);
    if (ch < 32 || ch > 127) {
      const next = this.peekChar();
      if (next >= 32 && next <= 127) {
        this.nextChar();
        return new Cmd(word);
      }
    }
    while ((ch = this.nextChar()) >= 0 && !CLASS[ch]) {
      if (word.length === 128) throw new Unreadable("a command too long");
      word += String.fromCharCode(ch);
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return new Cmd(word);
  }

  private number(): number {
    let ch = this.current;
    let divideBy = 0;
    let sign = 1;
    if (ch === 45) {
      sign = -1;
      ch = this.nextChar();
      if (ch === 45) ch = this.nextChar();
    } else if (ch === 43) ch = this.nextChar();
    if (ch === 10 || ch === 13) {
      do ch = this.nextChar();
      while (ch === 10 || ch === 13);
    }
    if (ch === 46) {
      divideBy = 10;
      ch = this.nextChar();
    }
    if (ch < 48 || ch > 57) {
      if (isWhiteSpace(ch) || ch === 40 || ch === 60 || ch === -1) return 0;
      throw new Unreadable("an invalid number");
    }
    let value = ch - 48;
    while ((ch = this.nextChar()) >= 0) {
      if (ch >= 48 && ch <= 57) {
        if (divideBy !== 0) divideBy *= 10;
        value = value * 10 + (ch - 48);
      } else if (ch === 46) {
        if (divideBy === 0) divideBy = 1;
        else break;
      } else if (ch !== 45) break;
    }
    if (divideBy !== 0) value /= divideBy;
    return sign * value;
  }

  private string(): typeof STRING {
    let depth = 1;
    let ch = this.nextChar();
    for (;;) {
      let buffered = false;
      let done = false;
      switch (ch) {
        case -1:
          done = true;
          break;
        case 40:
          ++depth;
          break;
        case 41:
          if (--depth === 0) {
            this.nextChar();
            done = true;
          }
          break;
        case 92:
          ch = this.nextChar();
          if (ch === -1) done = true;
          else if (ch >= 48 && ch <= 55) {
            // Up to three octal digits; a char after fewer is read again as the string's own.
            ch = this.nextChar();
            buffered = true;
            if (ch >= 48 && ch <= 55) {
              ch = this.nextChar();
              if (ch >= 48 && ch <= 55) buffered = false;
            }
          } else if (ch === 13 && this.peekChar() === 10) this.nextChar();
          break;
      }
      if (done) return STRING;
      if (!buffered) ch = this.nextChar();
    }
  }

  private name(): Name {
    let name = "";
    let ch: number;
    while ((ch = this.nextChar()) >= 0 && !CLASS[ch]) {
      if (ch !== 35) {
        name += String.fromCharCode(ch);
        continue;
      }
      ch = this.nextChar();
      if (ch >= 0 && CLASS[ch]) {
        name += "#";
        break;
      }
      const high = hexDigit(ch);
      if (high === -1) {
        name += `#${String.fromCharCode(Math.max(ch, 0))}`;
        continue;
      }
      const first = ch;
      ch = this.nextChar();
      const low = hexDigit(ch);
      if (low === -1) {
        name += `#${String.fromCharCode(first)}`;
        if (ch < 0 || CLASS[ch]) break;
        name += String.fromCharCode(ch);
        continue;
      }
      name += String.fromCharCode((high << 4) | low);
    }
    return new Name(name);
  }

  private hexString(): typeof STRING {
    let ch = this.current;
    for (;;) {
      if (ch < 0) break;
      if (ch === 62) {
        this.nextChar();
        break;
      }
      ch = this.nextChar();
    }
    return STRING;
  }
}

/** The deepest an object nests before it is left unread: pdf.js has no such bound, but nothing real comes near it. */
const MAX_DEPTH = 256;

/** pdf.js's Parser: two tokens ahead, a dictionary key that is not a name skipped, the last value of a key kept. */
class Parser {
  private buf1: Value;
  private buf2: Value;
  /** `onInnerStream` hears of a stream that is a value inside another object, as pdf.js reads one. */
  constructor(
    private readonly lexer: Lexer,
    private readonly onInnerStream?: (dict: Dict) => void
  ) {
    this.buf1 = lexer.token();
    this.buf2 = lexer.token();
  }
  private shift() {
    this.buf1 = this.buf2;
    this.buf2 = this.lexer.token();
  }
  /** One value. A dictionary followed by `stream` is a StreamStart, its data found from the lexer's position. */
  value(depth = 0): Value {
    if (depth > MAX_DEPTH) throw new Unreadable("nested too deep");
    const buf1 = this.buf1;
    this.shift();
    if (buf1 instanceof Cmd) {
      if (buf1.cmd === "[") {
        const array: Value[] = [];
        while (!(this.buf1 instanceof Cmd && this.buf1.cmd === "]") && this.buf1 !== EOF) array.push(this.value(depth + 1));
        if (this.buf1 === EOF) throw new Unreadable("the file ends inside an array");
        this.shift();
        return array;
      }
      if (buf1.cmd === "<<") {
        const dict = new Dict();
        while (!(this.buf1 instanceof Cmd && this.buf1.cmd === ">>") && this.buf1 !== EOF) {
          if (!(this.buf1 instanceof Name)) {
            this.shift();
            continue;
          }
          const key = this.buf1.name;
          this.shift();
          // shift() moved on: what TypeScript narrowed above is the token before.
          if ((this.buf1 as Value) === EOF) break;
          dict.map.set(key, this.value(depth + 1));
        }
        if (this.buf1 === EOF) throw new Unreadable("the file ends inside a dictionary");
        // The lexer has just read `stream`: the char after it is where its line ends.
        if (this.buf2 instanceof Cmd && this.buf2.cmd === "stream") {
          if (depth === 0) return new StreamStart(dict, -1);
          // A stream as another object's value, which pdf.js reads as that value: measured, and the rest left unread.
          this.onInnerStream?.(dict);
          throw new Unreadable("a stream inside another object");
        }
        this.shift();
        return dict;
      }
      return buf1;
    }
    if (typeof buf1 === "number" && Number.isInteger(buf1) && typeof this.buf1 === "number" && Number.isInteger(this.buf1) && this.buf2 instanceof Cmd && this.buf2.cmd === "R") {
      const ref = new Ref(buf1, this.buf1);
      this.shift();
      this.shift();
      return ref;
    }
    return buf1;
  }
}

// ------------------------------------------------------------------------------------------------ pdf.js's decoders

const CODE_LENGTH_ORDER = Int32Array.from([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const LENGTHS = Int32Array.from([
  3, 4, 5, 6, 7, 8, 9, 10, 65547, 65549, 65551, 65553, 131091, 131095, 131099, 131103, 196643, 196651, 196659, 196667, 262211, 262227, 262243,
  262259, 327811, 327843, 327875, 327907, 258, 258, 258,
]);
const DISTANCES = Int32Array.from([
  1, 2, 3, 4, 65541, 65543, 131081, 131085, 196625, 196633, 262177, 262193, 327745, 327777, 393345, 393409, 459009, 459137, 524801, 525057,
  590849, 591361, 657409, 658433, 724993, 727041, 794625, 798721, 868353, 876545,
]);
type Table = readonly [Int32Array, number];

/** pdf.js's `generateHuffmanTable`, which builds a table from any code lengths, complete or not. */
function huffmanTable(lengths: Uint8Array): Table {
  let maxLength = 0;
  for (let i = 0; i < lengths.length; ++i) if (lengths[i] > maxLength) maxLength = lengths[i];
  const size = 1 << maxLength;
  const codes = new Int32Array(size);
  for (let length = 1, code = 0, skip = 2; length <= maxLength; ++length, code <<= 1, skip <<= 1) {
    for (let value = 0; value < lengths.length; ++value) {
      if (lengths[value] !== length) continue;
      let reversed = 0;
      let rest = code;
      for (let i = 0; i < length; ++i) {
        reversed = (reversed << 1) | (rest & 1);
        rest >>= 1;
      }
      for (let i = reversed; i < size; i += skip) codes[i] = (length << 16) | value;
      ++code;
    }
  }
  return [codes, maxLength];
}
const FIXED_LITERALS = huffmanTable(Uint8Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DISTANCES = huffmanTable(new Uint8Array(30).fill(5));

/** What a decoder made: its length, the bytes when kept, whether it passed its limit, and how much of its input it read. */
interface Decoded {
  length: number;
  bytes: Uint8Array | null;
  over: boolean;
  /** Bytes read and table entries built, the scan's measure of work. */
  work: number;
}

/** A growing output, held only when kept. */
class Output {
  length = 0;
  private buffer: Uint8Array | null;
  constructor(keep: boolean) {
    this.buffer = keep ? new Uint8Array(512) : null;
  }
  ensure(size: number) {
    if (!this.buffer || size <= this.buffer.length) return;
    let next = this.buffer.length;
    while (next < size) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
  get kept(): Uint8Array | null {
    return this.buffer ? this.buffer.subarray(0, this.length) : null;
  }
  get raw(): Uint8Array | null {
    return this.buffer;
  }
}

/** pdf.js stopped decoding here: a bad code, a bad block, or the data ran out. What it made until then stays made. */
const STOP = new Error("stop");

/**
 * pdf.js's FlateStream, decoding `input` as pdf.js would, up to `maxOut` bytes out and `maxWork` of work. With `keep`, the
 * bytes; otherwise only their count, since a copy's length never depends on what it copies.
 */
function inflateLikePdfjs(input: Uint8Array, maxOut: number, maxWork: number, keep: boolean): Decoded {
  const end = input.length;
  const out = new Output(keep);
  let pos = 0;
  let tables = 0;
  const result = (over: boolean): Decoded => ({ length: out.length, bytes: out.kept, over, work: pos + tables });
  // pdf.js's constructor checks the zlib header; a stream that fails it decodes to nothing.
  if (end < 2) return result(false);
  const cmf = input[0];
  const flg = input[1];
  pos = 2;
  if ((cmf & 15) !== 8 || ((cmf << 8) + flg) % 31 !== 0 || flg & 32) return result(false);

  let codeBuf = 0;
  let codeSize = 0;
  const getBits = (bits: number): number => {
    while (codeSize < bits) {
      if (pos >= end) throw STOP;
      codeBuf |= input[pos++] << codeSize;
      codeSize += 8;
    }
    const value = codeBuf & ((1 << bits) - 1);
    codeBuf >>= bits;
    codeSize -= bits;
    return value;
  };
  const getCode = ([codes, maxLength]: Table): number => {
    while (codeSize < maxLength && pos < end) {
      codeBuf |= input[pos++] << codeSize;
      codeSize += 8;
    }
    const code = codes[codeBuf & ((1 << maxLength) - 1)];
    const length = code >> 16;
    if (length < 1 || codeSize < length) throw STOP;
    codeBuf >>= length;
    codeSize -= length;
    return code & 0xffff;
  };
  const table = (lengths: Uint8Array): Table => {
    const built = huffmanTable(lengths);
    tables += built[0].length;
    return built;
  };

  try {
    let last = false;
    while (!last) {
      if (pos + tables > maxWork) return { ...result(false), work: maxWork + 1 };
      let header: number;
      try {
        header = getBits(3);
      } catch {
        break;
      }
      if (header & 1) last = true;
      header >>= 1;
      if (header === 0) {
        // A stored block.
        if (end - pos < 4) break;
        const length = input[pos] | (input[pos + 1] << 8);
        const check = input[pos + 2] | (input[pos + 3] << 8);
        pos += 4;
        if (check !== (~length & 0xffff) && (length !== 0 || check !== 0)) throw STOP;
        codeBuf = 0;
        codeSize = 0;
        const target = out.length + length;
        if (target > maxOut) {
          out.length = target;
          return result(true);
        }
        out.ensure(target);
        if (length === 0) {
          if (pos >= end) last = true;
        } else {
          const take = Math.min(length, end - pos);
          out.raw?.set(input.subarray(pos, pos + take), out.length);
          pos += take;
          if (take < length) last = true;
        }
        out.length = target;
        continue;
      }
      let literals: Table;
      let distances: Table;
      if (header === 1) {
        literals = FIXED_LITERALS;
        distances = FIXED_DISTANCES;
      } else if (header === 2) {
        const literalCount = getBits(5) + 257;
        const distanceCount = getBits(5) + 1;
        const lengthCount = getBits(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < lengthCount; ++i) codeLengths[CODE_LENGTH_ORDER[i]] = getBits(3);
        const lengthTable = table(codeLengths);
        const total = literalCount + distanceCount;
        const lengths = new Uint8Array(total);
        let previous = 0;
        let i = 0;
        while (i < total) {
          const code = getCode(lengthTable);
          let bits: number;
          let offset: number;
          let what: number;
          if (code === 16) {
            bits = 2;
            offset = 3;
            what = previous;
          } else if (code === 17) {
            bits = 3;
            offset = 3;
            what = previous = 0;
          } else if (code === 18) {
            bits = 7;
            offset = 11;
            what = previous = 0;
          } else {
            lengths[i++] = previous = code;
            continue;
          }
          let repeat = getBits(bits) + offset;
          while (repeat-- > 0) lengths[i++] = what;
        }
        literals = table(lengths.subarray(0, literalCount));
        distances = table(lengths.subarray(literalCount, total));
      } else throw STOP;

      for (;;) {
        let code = getCode(literals);
        if (code < 256) {
          if (out.length + 1 > maxOut) {
            out.length++;
            return result(true);
          }
          out.ensure(out.length + 1);
          const raw = out.raw;
          if (raw) raw[out.length] = code;
          out.length++;
          continue;
        }
        if (code === 256) break;
        code = LENGTHS[code - 257] ?? 0;
        let extra = code >> 16;
        if (extra > 0) extra = getBits(extra);
        const length = (code & 0xffff) + extra;
        code = DISTANCES[getCode(distances)] ?? 0;
        extra = code >> 16;
        if (extra > 0) extra = getBits(extra);
        const distance = (code & 0xffff) + extra;
        const target = out.length + length;
        if (target > maxOut) {
          out.length = target;
          return result(true);
        }
        out.ensure(target);
        const raw = out.raw;
        // pdf.js copies from before its buffer as it is: nothing there reads as a zero.
        if (raw) for (let k = out.length; k < target; ++k) raw[k] = k - distance >= 0 ? raw[k - distance] : 0;
        out.length = target;
        if (pos + tables > maxWork) return { ...result(false), work: maxWork + 1 };
      }
    }
  } catch (error) {
    if (error !== STOP) throw error;
  }
  return result(false);
}

/** pdf.js's AsciiHexStream: hex digits in pairs, anything else skipped, to the first `>`. */
function asciiHexLikePdfjs(input: Uint8Array, maxOut: number): Decoded {
  const out = new Output(true);
  let first = -1;
  let pos = 0;
  for (; pos < input.length; pos++) {
    const ch = input[pos];
    if (ch === 62) {
      pos++;
      if (first >= 0) {
        out.ensure(out.length + 1);
        out.raw![out.length++] = first << 4;
      }
      break;
    }
    const digit = hexDigit(ch);
    if (digit === -1) continue;
    if (first < 0) first = digit;
    else {
      if (out.length + 1 > maxOut) return { length: out.length + 1, bytes: null, over: true, work: pos };
      out.ensure(out.length + 1);
      out.raw![out.length++] = (first << 4) | digit;
      first = -1;
    }
  }
  return { length: out.length, bytes: out.kept, over: false, work: pos };
}

/** pdf.js's Ascii85Stream: groups of five, `z` for four zeros, whitespace skipped, to the first `~`. */
function ascii85LikePdfjs(input: Uint8Array, maxOut: number): Decoded {
  const out = new Output(true);
  const group = new Uint8Array(5);
  let pos = 0;
  const next = () => (pos < input.length ? input[pos++] : -1);
  for (;;) {
    let ch = next();
    while (isWhiteSpace(ch)) ch = next();
    if (ch === -1 || ch === 126) break;
    if (ch === 122) {
      if (out.length + 4 > maxOut) return { length: out.length + 4, bytes: null, over: true, work: pos };
      out.ensure(out.length + 4);
      out.raw!.fill(0, out.length, out.length + 4);
      out.length += 4;
      continue;
    }
    group[0] = ch;
    let i = 1;
    for (; i < 5; ++i) {
      ch = next();
      while (isWhiteSpace(ch)) ch = next();
      group[i] = ch;
      if (ch === -1 || ch === 126) break;
    }
    if (out.length + 4 > maxOut) return { length: out.length + i - 1, bytes: null, over: true, work: pos };
    out.ensure(out.length + 4);
    const raw = out.raw!;
    const start = out.length;
    out.length += i - 1;
    if (i < 5) group.fill(117, i, 5);
    let value = 0;
    for (let k = 0; k < 5; ++k) value = value * 85 + (group[k] - 33);
    for (let k = 3; k >= 0; --k) {
      raw[start + k] = value & 255;
      value >>= 8;
    }
    if (i < 5) break;
  }
  return { length: out.length, bytes: out.kept, over: false, work: pos };
}

/**
 * `data` inflated as pdf.js inflates a FlateDecode stream, its zlib header included, up to `maxOut` bytes: the bytes, how
 * many, and whether it stopped at `maxOut`. For tests and for the scan.
 */
export function inflateAsPdfjs(data: Uint8Array, maxOut = Number.MAX_SAFE_INTEGER): { length: number; bytes: Uint8Array; over: boolean } {
  const decoded = inflateLikePdfjs(data, maxOut, Number.MAX_SAFE_INTEGER, true);
  return { length: decoded.length, bytes: decoded.bytes ?? new Uint8Array(0), over: decoded.over };
}

// ------------------------------------------------------------------------------------------------ the scan

const FLATE = new Set(["FlateDecode", "Fl"]);
const ASCII_HEX = new Set(["ASCIIHexDecode", "AHx"]);
const ASCII_85 = new Set(["ASCII85Decode", "A85"]);
/** Filters pdf.js decodes whose output the scan cannot measure. Any other name pdf.js passes the data through. */
const UNMEASURED = new Set([
  "LZWDecode",
  "LZW",
  "RunLengthDecode",
  "RL",
  "BrotliDecode",
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "JPX",
  "CCITTFaxDecode",
  "CCF",
  "JBIG2Decode",
]);
/** The keys whose streams pdf.js decodes to read a page's text: its contents, fonts, character maps and glyph procedures. */
const TEXT_KEYS = new Set(["Contents", "FontFile", "FontFile2", "FontFile3", "ToUnicode", "Encoding", "UseCMap", "CIDToGIDMap", "CharProcs"]);
/** The most of the file one object is read through. */
const OBJECT_WINDOW = 64 * 1024;
const UNRESOLVED = Symbol("unresolved");

interface Found {
  start: StreamStart;
  num: number | null;
}

class Scan {
  decoded = 0;
  private work = 0;
  private readonly text: string;
  private readonly objects = new Map<number, Value>();
  private readonly streams: Found[] = [];
  private readonly textRefs = new Set<number>();
  /** Objects a text key names that may be an array or dictionary of more: a page's contents, a font's glyphs. */
  private readonly containers = new Set<number>();
  private encrypted = false;
  /** A stream read for text was skipped, its filter one the scan cannot measure. */
  private skipped = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: PrescanLimits
  ) {
    this.text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  }

  /** A file of more streams, or more work, than the limits is refused at once. */
  private tooComplex(): never {
    throw new Refused("too_complex");
  }

  /**
   * A stream whose filter the scan cannot measure is skipped, and the rest are still measured: the file is refused for
   * it only once they are, under the budget, so a bomb beside it is refused as that, before any reader opens the file
   * (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB6).
   */
  private unmeasured(): true {
    this.skipped = true;
    return true;
  }

  private spend(amount: number) {
    this.work += amount;
    if (this.work > this.limits.maxWorkBytes) this.tooComplex();
  }

  run(): void {
    this.readObjects();
    const strays = this.strayStreams();
    if (this.streams.length + strays.length > this.limits.maxStreams) return this.tooComplex();
    // Object streams first: the objects inside them may name the filters, and the contents, of the rest.
    const ordered = [...this.streams].sort((a, b) => Number(isObjectStream(b.start.dict)) - Number(isObjectStream(a.start.dict)));
    const later: Found[] = [];
    for (const found of ordered) {
      if (labelledUnread(found.start.dict, (v) => this.resolve(v)) || !this.measure(found, false)) later.push(found);
    }
    this.followContainers();
    for (const found of later) {
      if (this.leftOut(found)) continue;
      this.measure(found, true);
    }
    for (const at of strays) this.count(inflateLikePdfjs(this.bytes.subarray(at), this.left, this.workLeft, false));
    // Every stream it could measure is under the budget. An encrypted file's streams were measured as written, not as
    // pdf.js decrypts them, so it is refused all the same; and so is one with a stream skipped.
    if (this.encrypted) throw new Refused("encrypted");
    if (this.skipped) throw new Refused("unbounded_filter");
  }

  private get left(): number {
    return this.limits.maxDecodedBytes - this.decoded;
  }
  private get workLeft(): number {
    return this.limits.maxWorkBytes - this.work;
  }

  private count(decoded: Decoded): void {
    this.decoded += decoded.length;
    if (decoded.over) throw new Refused("decoded_limit");
    this.spend(decoded.work);
  }

  /** pdf.js's `xref.fetch` of a reference, one level, as `Dict.get` does it. */
  private resolve(value: Value | undefined): Value | undefined | typeof UNRESOLVED {
    if (!(value instanceof Ref)) return value;
    return this.objects.has(value.num) ? this.objects.get(value.num) : UNRESOLVED;
  }

  /** A stream named an image or an embedded file that nothing pdf.js reads for text names: pdf.js never decodes it. */
  private leftOut(found: Found): boolean {
    if (!labelledUnread(found.start.dict, (v) => this.resolve(v))) return false;
    return found.num !== null && !this.textRefs.has(found.num);
  }

  /** Decodes a stream's filters as pdf.js applies them. False when its filter is in an object not read yet. */
  private measure(found: Found, final: boolean): boolean {
    const { dict, dataStart } = found.start;
    const filter = this.resolve(dict.get("F", "Filter"));
    let names: string[];
    if (filter === UNRESOLVED) {
      if (!final) return false;
      return this.unmeasured();
    }
    if (filter instanceof Name) names = [filter.name];
    else if (Array.isArray(filter)) {
      names = [];
      for (const each of filter) {
        const name = this.resolve(each);
        if (name === UNRESOLVED) {
          if (!final) return false;
          return this.unmeasured();
        }
        // pdf.js refuses a filter that is not a name, and decodes nothing of the stream.
        if (!(name instanceof Name)) return true;
        names.push(name.name);
      }
    } else names = [];
    if (names.some((name) => UNMEASURED.has(name))) return this.unmeasured();
    const objectStream = isObjectStream(dict);
    let data: Uint8Array = this.bytes.subarray(dataStart);
    for (let i = 0; i < names.length; i++) {
      const keep = i < names.length - 1 || objectStream;
      let decoded: Decoded;
      if (FLATE.has(names[i])) decoded = inflateLikePdfjs(data, this.left, this.workLeft, keep);
      else if (ASCII_HEX.has(names[i])) decoded = asciiHexLikePdfjs(data, this.left);
      else if (ASCII_85.has(names[i])) decoded = ascii85LikePdfjs(data, this.left);
      else continue;
      this.count(decoded);
      data = decoded.bytes ?? new Uint8Array(0);
    }
    if (objectStream) this.readObjectStream(dict, data);
    return true;
  }

  /** Every `obj` keyword's object, and every trailer, read with pdf.js's grammar. */
  private readObjects(): void {
    const { text, bytes } = this;
    for (let at = text.indexOf("obj"); at !== -1; at = text.indexOf("obj", at + 3)) {
      const before = at > 0 ? bytes[at - 1] : -1;
      const after = at + 3 < bytes.length ? bytes[at + 3] : -1;
      // "endobj" is no object; "5 0obj" is one.
      if (!(before === -1 || CLASS[before] || isDigit(before)) || !(after === -1 || CLASS[after])) continue;
      const value = this.readAt(at + 3);
      if (value === undefined) continue;
      const num = objectNumberBefore(bytes, at);
      if (value instanceof StreamStart) {
        this.streams.push({ start: value, num });
        if (value.dict.map.has("Encrypt")) this.encrypted = true;
        if (this.streams.length > this.limits.maxStreams) this.tooComplex();
      }
      if (num !== null) this.objects.set(num, value);
      this.walk(value);
    }
    for (let at = text.indexOf("trailer"); at !== -1; at = text.indexOf("trailer", at + 7)) {
      const value = this.readAt(at + 7);
      if (value instanceof Dict && value.map.has("Encrypt")) this.encrypted = true;
      if (value !== undefined) this.walk(value);
    }
  }

  /** One value read from `start`, within OBJECT_WINDOW; a stream's data found where pdf.js finds it. */
  private readAt(start: number): Value | undefined {
    const lexer = new Lexer(this.bytes, start, Math.min(this.bytes.length, start + OBJECT_WINDOW));
    const inner = (dict: Dict) => this.streams.push({ start: new StreamStart(dict, dataStartAfter(this.bytes, lexer.at)), num: null });
    try {
      const value = new Parser(lexer, inner).value();
      if (value instanceof StreamStart) return new StreamStart(value.dict, dataStartAfter(this.bytes, lexer.at));
      return value === EOF ? undefined : value;
    } catch (error) {
      if (error instanceof Unreadable) return undefined;
      throw error;
    } finally {
      this.spend(lexer.read);
    }
  }

  /** `stream` keywords that no object read led to. */
  private strayStreams(): number[] {
    const { text, bytes } = this;
    const found = new Set(this.streams.map((each) => each.start.dataStart));
    const strays: number[] = [];
    for (let at = text.indexOf("stream"); at !== -1; at = text.indexOf("stream", at + 6)) {
      const before = at > 0 ? bytes[at - 1] : -1;
      const after = at + 6 < bytes.length ? bytes[at + 6] : -1;
      if (!(before === -1 || CLASS[before] || isDigit(before)) || !(after === -1 || CLASS[after])) continue;
      const dataStart = dataStartAfter(bytes, at + 6);
      if (!found.has(dataStart)) strays.push(dataStart);
    }
    return strays;
  }

  /** The members of an object stream, read into the objects pdf.js could fetch, and walked for what names text. */
  private readObjectStream(dict: Dict, data: Uint8Array): void {
    const count = this.resolve(dict.get("N"));
    const first = this.resolve(dict.get("First"));
    if (typeof count === "number" && Number.isInteger(count) && typeof first === "number" && Number.isInteger(first) && count >= 0 && first >= 0) {
      const header = new Lexer(data, 0, Math.min(data.length, first));
      try {
        const parser = new Parser(header);
        const members: Array<[number, number]> = [];
        for (let i = 0; i < count && i < this.limits.maxStreams * 10; i++) {
          const num = parser.value();
          const offset = parser.value();
          if (typeof num !== "number" || typeof offset !== "number") break;
          members.push([num, offset]);
        }
        for (const [num, offset] of members) {
          const at = first + offset;
          if (!(at >= 0 && at < data.length)) continue;
          const lexer = new Lexer(data, at, Math.min(data.length, at + OBJECT_WINDOW));
          try {
            const value = new Parser(lexer).value();
            if (value === EOF) continue;
            if (!this.objects.has(num)) this.objects.set(num, value);
            this.walk(value);
          } catch (error) {
            if (!(error instanceof Unreadable)) throw error;
          } finally {
            this.spend(lexer.read);
          }
        }
        return;
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
      } finally {
        this.spend(header.read);
      }
    }
    // A header it cannot read: every value in it walked, for what names text.
    const lexer = new Lexer(data, 0, data.length);
    try {
      const parser = new Parser(lexer);
      for (let value = parser.value(); value !== EOF; value = parser.value()) this.walk(value);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
    } finally {
      this.spend(lexer.read);
    }
  }

  /** Every reference a text key holds, in `value` and everything inside it. */
  private walk(value: Value): void {
    const stack: Value[] = [value];
    while (stack.length > 0) {
      const each = stack.pop()!;
      const dict = each instanceof StreamStart ? each.dict : each instanceof Dict ? each : null;
      if (dict) {
        for (const [key, inner] of dict.map) {
          if (TEXT_KEYS.has(key)) this.nameText(inner);
          stack.push(inner);
        }
      } else if (Array.isArray(each)) stack.push(...each);
    }
  }

  private nameText(value: Value): void {
    if (value instanceof Ref) {
      this.textRefs.add(value.num);
      this.containers.add(value.num);
    } else if (Array.isArray(value)) {
      for (const each of value) if (each instanceof Ref) this.textRefs.add(each.num);
    } else if (value instanceof Dict) {
      for (const each of value.map.values()) if (each instanceof Ref) this.textRefs.add(each.num);
    }
  }

  /** A page's contents kept as an array in another object, or a font's glyph procedures as a dictionary in one. */
  private followContainers(): void {
    for (const num of this.containers) {
      const held = this.objects.get(num);
      if (Array.isArray(held) || held instanceof Dict) this.nameText(held);
    }
  }
}

/** An object stream: pdf.js reads objects out of any stream it is told holds them, by its N and First. */
function isObjectStream(dict: Dict): boolean {
  return dict.map.has("N") && dict.map.has("First");
}

/** Named an image or an embedded file, and nothing else pdf.js decodes on its own: no object stream, no cross-reference stream. */
function labelledUnread(dict: Dict, resolve: (value: Value | undefined) => Value | undefined | typeof UNRESOLVED): boolean {
  const type = resolve(dict.get("Type"));
  const subtype = resolve(dict.get("Subtype"));
  const named = (value: unknown, name: string) => value instanceof Name && value.name === name;
  if (!(named(subtype, "Image") || named(type, "EmbeddedFile"))) return false;
  if (named(type, "XRef") || named(type, "ObjStm") || dict.map.has("First") || dict.map.has("W")) return false;
  return true;
}

/** The object number before `obj` at `at`: "5 0 obj". Null when it cannot be read there. */
function objectNumberBefore(bytes: Uint8Array, at: number): number | null {
  let i = at - 1;
  while (i >= 0 && CLASS[bytes[i]] === WHITE) i--;
  const genEnd = i;
  while (i >= 0 && isDigit(bytes[i])) i--;
  if (i === genEnd) return null;
  const spaceEnd = i;
  while (i >= 0 && CLASS[bytes[i]] === WHITE) i--;
  if (i === spaceEnd) return null;
  const numEnd = i;
  while (i >= 0 && isDigit(bytes[i])) i--;
  if (i === numEnd || numEnd - i > 10) return null;
  if (i >= 0 && !CLASS[bytes[i]]) return null;
  return Number(Buffer.from(bytes.subarray(i + 1, numEnd + 1)).toString("latin1"));
}

/**
 * Whether `bytes`, a PDF, may go to pdf.js, and if not, why: see the module comment. The cycle refuses every refusal;
 * `readDocument` refuses a file measured over the budget, which takes precedence over the other reasons, and reads the
 * rest in a worker (RB1, RB6).
 */
export function prescanPdf(bytes: Uint8Array, options: { limits?: Partial<PrescanLimits> } = {}): Prescan {
  const scan = new Scan(bytes, { ...PRESCAN_LIMITS, ...options.limits });
  try {
    scan.run();
    return { refused: null, decodedBytes: scan.decoded };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { refused: error.why, decodedBytes: scan.decoded };
  }
}
