/*
 * The interface languages, one entry each. Adding a language is one entry here and one dictionary next to this file
 * (`<id>.json`, keyed by the English text: see AGENTS.md, "Languages").
 */
import type { Dictionary } from "./translator";

/**
 * How a language writes dates and numbers. The locales are handed to Intl, the patterns hold tokens: {yyyy} {yy} the
 * year, {M} {MM} the month's number, {MMM} its short name, {d} {dd} the day, {wd} the short weekday.
 */
export type Formats = {
  /** Dates written out ("Sep 10, 2003", "November 2026", the month names of the time axis). */
  dateLocale: string;
  /** Numbers: grouping and decimal marks. */
  numberLocale: string;
  /** The chart's date label in its default format ("26 Oct '26"). */
  chartDate: string;
  /** The same with the day of the week ("Mon 26 Oct '26"). */
  chartWeekdayDate: string;
  /** The short month names of the chart and the time axis, January first, where the language's own differ from
   *  Intl's ("Janv" for "janv."). Intl's when absent. */
  shortMonths?: readonly string[];
  /** The weekday heads of a calendar, Monday first. The code's ("Mo", "Tu"…) when absent. */
  calendarWeekdays?: readonly string[];
  /**
   * The marks of the numbers the code writes in English ("−1,234.5", "103.47 M", "+5.81%"): the thousands separator
   * and the decimal sign, and the space before a K / M / B / T letter. The English text as it is when absent.
   */
  numberMarks?: { group: string; decimal: string; unitSpace: string };
  /** Between the words of a list ("Value, line"): ", " when absent. */
  listSeparator?: string;
  /** A calendar's title, tokens {MMMM} the month's full name, {M} its number, {yyyy} the year ("{M}月 {yyyy}"). Intl's
   *  month and year when absent ("November 2026"). */
  calendarTitle?: string;
  /** A quarter, {q} its number ("T{q}"): "Q{q}" when absent. */
  quarter?: string;
  /**
   * The two units of a duration put together, {0} the larger: days and hours, hours and minutes. Where a language
   * doesn't join them in one way ("2時間16分", but a connector between days and hours); the dictionary's "{0} and {1}"
   * when absent ("2 Stunden und 16 Minuten").
   */
  durationJoin?: { daysHours: string; hoursMinutes: string };
  /** The language writes its nouns with a capital (German): a word the code puts in lowercase inside a text, as
   *  English does ("SMA 9 close", "Value, line"), keeps the dictionary's capital ("SMA 9 Schluss"). */
  capitalNouns?: boolean;
};

export type LanguageEntry = {
  /** BCP-47 tag, the dictionary's file name and the page's `lang`. */
  id: string;
  /** The language named in itself, for the language menu. */
  name: string;
  /** The dictionary (none for English, the language of the code). */
  dictionary?: () => Promise<{ default: Dictionary }>;
  /** The locale whose plural rules pick a text's form (Intl.PluralRules). */
  pluralLocale: string;
  formats: Formats;
  /** Writing direction: the page's `dir`. */
  direction: "ltr" | "rtl";
  /** Still being translated: the missing texts are reported, not a test failure, and show in English. */
  partial?: boolean;
  /**
   * A test language generated from the catalog when it loads (pseudo.ts), no dictionary file: in the language menu of
   * a development build only, a production build loads it from the saved choice alone.
   */
  pseudo?: boolean;
};

export const ENGLISH: LanguageEntry = {
  id: "en",
  name: "English",
  pluralLocale: "en",
  formats: { dateLocale: "en-US", numberLocale: "en-US", chartDate: "{dd} {MMM} '{yy}", chartWeekdayDate: "{wd} {dd} {MMM} '{yy}" },
  direction: "ltr",
};

/**
 * The interface languages. Only English ships: the catalog and the translator
 * stay in place, so another language is still one entry here and one
 * `<id>.json` dictionary, but this build offers English alone.
 */
export const LANGUAGES: readonly LanguageEntry[] = [ENGLISH];

/** The languages the language menu offers (English only: see `LANGUAGES`). */
export function menuLanguages(): LanguageEntry[] {
  return LANGUAGES.filter((l) => !l.pseudo || import.meta.env.DEV);
}

export function languageEntry(id: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
