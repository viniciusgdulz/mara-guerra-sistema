import { describe, expect, test } from "bun:test";
import { hasMaxLength, isNonEmptyString } from "../src/validation";

describe("isNonEmptyString", () => {
  test.each(["Mara", "  Mara Guerra  "])("aceita texto: %j", (value) => {
    expect(isNonEmptyString(value)).toBe(true);
  });

  test.each(["", "   ", "\t\n", 123, null, undefined, true, {}])(
    "rejeita valor sem texto: %j", (value) => {
      expect(isNonEmptyString(value)).toBe(false);
    },
  );
});

describe("hasMaxLength", () => {
  test.each(["Mara", "Guerra", "", "   "])("aceita texto dentro do limite: %j", (value) => {
    expect(hasMaxLength(value, 6)).toBe(true);
  });

  test("rejeita texto acima do limite", () => {
    expect(hasMaxLength("Mara Guerra", 6)).toBe(false);
  });

  test("conta os espaços no tamanho original", () => {
    expect(hasMaxLength(" Mara ", 4)).toBe(false);
  });

  test("aceita apenas string vazia quando o limite é zero", () => {
    expect(hasMaxLength("", 0)).toBe(true);
    expect(hasMaxLength("a", 0)).toBe(false);
  });

  test.each([123, null, undefined, true, {}])("rejeita valor que não é string: %j", (value) => {
    expect(hasMaxLength(value, 6)).toBe(false);
  });
});
