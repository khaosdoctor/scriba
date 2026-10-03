export type Row = [text: string, callbackData: string][];

export type Keyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

export const keyboard = (rows: Row[]): Keyboard => ({
  inline_keyboard: rows.map((row) =>
    row.map(([text, callback_data]) => ({ text, callback_data })),
  ),
});

export const NO_BUTTONS: Keyboard = { inline_keyboard: [] };
