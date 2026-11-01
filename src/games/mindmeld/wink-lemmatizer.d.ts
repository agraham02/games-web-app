/** `wink-lemmatizer` ships no types: three functions, each taking a word and returning its base form. */
declare module "wink-lemmatizer" {
  export function noun(word: string): string;
  export function verb(word: string): string;
  export function adjective(word: string): string;
}
