import * as config from 'config';
import type * as defaultConfig from '../config/default.json';

export type DefaultConfig = typeof defaultConfig;

export type PartialDefaultConfig = DeepPartial<DefaultConfig>;

export type SafeConfig = {
  get<T extends DefaultConfigValues>(key: T): DeepKey<DefaultConfig, T>;
};

export default config as SafeConfig;

type ConcatKeys<T, Prefix extends string = ''> = ValueOf<{
  [Key in keyof T &
    string]: `${Prefix}${T[Key] extends { [K: string]: unknown } ? ConcatKeys<T[Key], `${Key}.`> | Key : Key}`;
}>;

type DefaultConfigValues = ConcatKeys<DefaultConfig>;

type DeepKey<T, FullKey extends string> = FullKey extends `${infer Key extends keyof T & string}.${infer Rest}`
  ? DeepKey<T[Key], Rest>
  : FullKey extends infer Key extends keyof T
    ? T[Key]
    : never;

type ValueOf<T> = T[keyof T];

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;
