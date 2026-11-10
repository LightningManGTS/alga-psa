import { describe, expect, it } from "vitest";
import { STOCK_EMAIL_PALETTE, type EmailPaletteTokens } from "@alga-psa/email/branding";
import { getSampleDataForPreview } from "./templateSampleData";

const TERRACOTTA: EmailPaletteTokens = {
  ...STOCK_EMAIL_PALETTE,
  primary: "#b4552f",
  dark: "#873f23",
  cardBorder: "#f3e1d9",
  infoBoxBorder: "#f5e6df",
};

describe("getSampleDataForPreview palette", () => {
  it("keeps the stock-colored detail tables without a palette", () => {
    const data = getSampleDataForPreview("ticket-closed-client", "", "");
    expect(data["ticket.timeHtml"]).toContain(`color:${STOCK_EMAIL_PALETTE.dark}`);
    expect(data["ticket.assetsHtml"]).toContain(`border-bottom:2px solid ${STOCK_EMAIL_PALETTE.cardBorder}`);
  });

  it("recolors the pre-rendered tables with the applied palette", () => {
    const data = getSampleDataForPreview("ticket-closed-internal", "", "", TERRACOTTA);
    for (const path of ["ticket.timeHtml", "ticket.assetsHtml", "ticket.materialsHtml"]) {
      const html = data[path];
      expect(html).toContain(`color:${TERRACOTTA.dark}`);
      expect(html).toContain(`border-bottom:2px solid ${TERRACOTTA.cardBorder}`);
      expect(html).toContain(`border-bottom:1px solid ${TERRACOTTA.infoBoxBorder}`);
      expect(html).not.toContain(STOCK_EMAIL_PALETTE.dark);
      // Body text is neutral, not a palette token.
      expect(html).toContain("color:#1f2933");
    }
  });

  it("leaves plain-text samples untouched", () => {
    const stock = getSampleDataForPreview("ticket-closed-internal", "", "");
    const branded = getSampleDataForPreview("ticket-closed-internal", "", "", TERRACOTTA);
    expect(branded["ticket.totalTimeWorked"]).toBe(stock["ticket.totalTimeWorked"]);
    expect(branded["ticket.title"]).toBe(stock["ticket.title"]);
  });
});
