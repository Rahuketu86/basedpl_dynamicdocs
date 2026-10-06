declare module './basedpl_web.js' {
  export class BplSession {
    constructor(): void;
    eval(code: string): string;
    complete(prefix: string): unknown;
  }
  export default function init(): Promise<void>;
}
