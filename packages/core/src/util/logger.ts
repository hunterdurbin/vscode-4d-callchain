export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.error(m),
  warn: (m) => console.error(m),
  error: (m) => console.error(m)
};
