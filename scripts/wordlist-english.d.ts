/** `wordlist-english` ships no types: an object of word lists by SCOWL level, e.g. "english/35". */
declare module "wordlist-english" {
  const lists: Record<string, string[]>;
  export default lists;
}
