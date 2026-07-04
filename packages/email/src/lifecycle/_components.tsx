/**
 * Shared primitives for the lifecycle email templates (#8–#20), translated from
 * the Claude Design cards into email-safe React Email components (everything
 * renders to nested tables — no flex/grid survives real clients).
 *
 * Layout contract (every lifecycle email):
 *   <EmailShell> = 600px white card on the light page bg —
 *     header row (CID color icon + lowercase wordmark) ·
 *     body (children, 34/40px padding) ·
 *     footer (tagline, Open app · Notification settings · Unsubscribe, postal).
 *
 * The brand icon references the CID attachment `gg-icon-color` that
 * {@link ../templates.ts sendEmail} attaches to every message.
 */

import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";
import {
  ACCENT,
  ACCENT_HOVER,
  BORDER,
  CARD_HEADER_BORDER,
  FOOTER_BG,
  GREEN_TINT,
  GREEN_TINT_BORDER,
  HAIRLINE,
  INK,
  INK_2,
  INK_3,
  MONO,
  PAGE_BG,
  SANS,
  SUCCESS,
  SUCCESS_TINT,
  SUCCESS_TINT_BORDER,
  SURFACE,
  SURFACE_2,
  TAGLINE,
  WORDMARK,
  postalAddress,
  webOrigin,
} from "./tokens.js";

/** Footer/CTA link targets; the send-guard fills the per-user unsubscribe URL. */
export interface ShellLinks {
  /** "Open app" footer link. Defaults to the marketing download page. */
  readonly openAppUrl?: string;
  /** Notification-settings page. */
  readonly settingsUrl?: string;
  /** Per-user signed unsubscribe URL (required for non-transactional sends). */
  readonly unsubscribeUrl?: string;
}

const CID_ICON_COLOR = "cid:gg-icon-color";

export function EmailShell(props: {
  /** Hidden preheader shown next to the subject in inbox list views. */
  preview: string;
  links?: ShellLinks;
  children: ReactNode;
}): ReactNode {
  const links = props.links ?? {};
  const openApp = links.openAppUrl ?? `${webOrigin()}/download`;
  const settings = links.settingsUrl ?? `${webOrigin()}/account/notifications`;
  return (
    <Html lang="en">
      <Head>
        <meta name="x-apple-disable-message-reformatting" />
        <meta name="color-scheme" content="light" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </Head>
      <Preview>{props.preview}</Preview>
      <Body style={{ margin: 0, padding: 0, backgroundColor: PAGE_BG }}>
        <Container
          width={600}
          style={{
            width: "600px",
            maxWidth: "600px",
            margin: "0 auto",
            padding: "32px 12px",
          }}
        >
          <Section
            style={{
              backgroundColor: "#ffffff",
              border: `1px solid ${BORDER}`,
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            {/* header */}
            <Row>
              <Column
                style={{
                  padding: "20px 40px",
                  borderBottom: `1px solid ${CARD_HEADER_BORDER}`,
                }}
              >
                <Img
                  src={CID_ICON_COLOR}
                  width="24"
                  height="24"
                  alt=""
                  style={{ display: "inline-block", verticalAlign: "middle" }}
                />
                <span
                  style={{
                    display: "inline-block",
                    verticalAlign: "middle",
                    marginLeft: "9px",
                    fontFamily: SANS,
                    fontWeight: 700,
                    fontSize: "16px",
                    letterSpacing: "-0.03em",
                    color: "#1f2937",
                  }}
                >
                  {WORDMARK}
                </span>
              </Column>
            </Row>

            {/* body */}
            <Row>
              <Column style={{ padding: "34px 40px 38px" }}>{props.children}</Column>
            </Row>

            {/* footer */}
            <Row>
              <Column
                style={{
                  padding: "22px 40px 28px",
                  borderTop: `1px solid ${CARD_HEADER_BORDER}`,
                  backgroundColor: FOOTER_BG,
                }}
              >
                <Text
                  style={{
                    margin: 0,
                    fontFamily: SANS,
                    fontSize: "11.5px",
                    lineHeight: 1.7,
                    color: INK_3,
                  }}
                >
                  {TAGLINE}
                  <br />
                  <Link href={openApp} style={footerLink}>
                    Open app
                  </Link>
                  &nbsp;·&nbsp;
                  <Link href={settings} style={footerLink}>
                    Notification settings
                  </Link>
                  {links.unsubscribeUrl ? (
                    <>
                      &nbsp;·&nbsp;
                      <Link href={links.unsubscribeUrl} style={footerLink}>
                        Unsubscribe
                      </Link>
                    </>
                  ) : null}
                  <br />
                  {postalAddress()}
                </Text>
              </Column>
            </Row>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const footerLink: CSSProperties = { color: INK_2, textDecoration: "none" };

/** Uppercase section tag above the headline ("Get started", "Run complete"…). */
export function Eyebrow(props: { color?: string; children: ReactNode }): ReactNode {
  return (
    <Text
      style={{
        margin: 0,
        fontFamily: SANS,
        fontSize: "10.5px",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: props.color ?? ACCENT,
      }}
    >
      {props.children}
    </Text>
  );
}

/** Card headline (h2 in the design, 23–25px semibold ink). */
export function Headline(props: { children: ReactNode }): ReactNode {
  return (
    <Text
      style={{
        margin: "10px 0 0",
        fontFamily: SANS,
        fontSize: "23px",
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: INK,
        lineHeight: 1.2,
      }}
    >
      {props.children}
    </Text>
  );
}

/** Standard body paragraph. */
export function Para(props: { children: ReactNode }): ReactNode {
  return (
    <Text
      style={{
        margin: "14px 0 0",
        fontFamily: SANS,
        fontSize: "15px",
        lineHeight: 1.6,
        color: INK_2,
      }}
    >
      {props.children}
    </Text>
  );
}

/** Inline monospace emphasis (table names, queries) in body copy. */
export function MonoInline(props: { accent?: boolean; children: ReactNode }): ReactNode {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "13.5px",
        color: props.accent ? ACCENT : INK,
      }}
    >
      {props.children}
    </span>
  );
}

/** Green CTA button; email-safe bulletproof-ish table button. */
export function Cta(props: { href: string; children: ReactNode }): ReactNode {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ marginTop: "26px" }}>
      <tbody>
        <tr>
          <td
            style={{
              backgroundColor: ACCENT,
              borderRadius: "6px",
              boxShadow: "0 1px 3px rgba(34,197,94,.35)",
            }}
          >
            <Link
              href={props.href}
              style={{
                display: "inline-block",
                padding: "12px 24px",
                fontFamily: SANS,
                fontSize: "14.5px",
                fontWeight: 600,
                color: "#ffffff",
                borderRadius: "6px",
              }}
            >
              {props.children}
            </Link>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Muted secondary link rendered beside/below a CTA. */
export function SecondaryLink(props: { href: string; children: ReactNode }): ReactNode {
  return (
    <Link
      href={props.href}
      style={{
        fontFamily: SANS,
        fontSize: "13.5px",
        color: INK_2,
        textDecoration: "none",
      }}
    >
      {props.children}
    </Link>
  );
}

/** Small monospace footnote under a CTA ("takes ~30 seconds · data stays local"). */
export function MonoNote(props: { children: ReactNode }): ReactNode {
  return (
    <Text
      style={{
        margin: "18px 0 0",
        fontFamily: MONO,
        fontSize: "11.5px",
        color: INK_3,
      }}
    >
      {props.children}
    </Text>
  );
}

/** Soft info box (the "you'll need an AI key" aside). */
export function InfoBox(props: { children: ReactNode }): ReactNode {
  return (
    <Section
      style={{
        marginTop: "24px",
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: "8px",
      }}
    >
      <Row>
        <Column style={{ padding: "14px 16px" }}>
          <Text
            style={{
              margin: 0,
              fontFamily: SANS,
              fontSize: "13.5px",
              lineHeight: 1.55,
              color: INK_2,
            }}
          >
            {props.children}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

// ─── Grid blocks ─────────────────────────────────────────────────────────────

export interface MiniGridColumn {
  readonly label: string;
  /** Optional chip after the label (e.g. "ƒ ai.generate") rendered green. */
  readonly fnChip?: string;
}

/**
 * The sample-table block (design email #8): row numbers + up to 3 columns of
 * mono cell values under a `SURFACE_2` header strip.
 */
export function MiniGrid(props: {
  columns: readonly MiniGridColumn[];
  rows: readonly (readonly string[])[];
}): ReactNode {
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{
        marginTop: "24px",
        border: `1px solid ${BORDER}`,
        borderRadius: "8px",
        borderCollapse: "separate",
        overflow: "hidden",
      }}
    >
      <tbody>
        <tr>
          <td style={{ ...gridHeadCell, width: "32px", textAlign: "center" }}>#</td>
          {props.columns.map((c, i) => (
            <td key={i} style={{ ...gridHeadCell, borderLeft: `1px solid ${BORDER}` }}>
              <span style={{ fontFamily: SANS, fontSize: "12px", fontWeight: 500, color: INK }}>
                {c.label}
              </span>
              {c.fnChip ? (
                <span
                  style={{
                    marginLeft: "6px",
                    fontFamily: MONO,
                    fontSize: "10px",
                    color: ACCENT,
                    backgroundColor: "#ffffff",
                    border: `1px solid ${GREEN_TINT_BORDER}`,
                    borderRadius: "4px",
                    padding: "1px 5px",
                  }}
                >
                  {c.fnChip}
                </span>
              ) : null}
            </td>
          ))}
        </tr>
        {props.rows.map((row, r) => (
          <tr key={r}>
            <td style={{ ...gridBodyCell(r === props.rows.length - 1), width: "32px", textAlign: "center", color: INK_3, fontSize: "11px" }}>
              {r + 1}
            </td>
            {row.map((cell, c) => (
              <td
                key={c}
                style={{
                  ...gridBodyCell(r === props.rows.length - 1),
                  borderLeft: `1px solid ${HAIRLINE}`,
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const gridHeadCell: CSSProperties = {
  borderBottom: `1px solid ${BORDER}`,
  backgroundColor: SURFACE_2,
  padding: "8px 10px",
  fontFamily: MONO,
  fontSize: "11px",
  color: INK_3,
};

function gridBodyCell(last: boolean): CSSProperties {
  return {
    padding: "8px 10px",
    fontFamily: MONO,
    fontSize: "12.5px",
    color: INK,
    borderBottom: last ? "none" : `1px solid ${HAIRLINE}`,
  };
}

// ─── Run summary (email #12) ─────────────────────────────────────────────────

export interface Stat {
  readonly value: string;
  readonly label: string;
  /** Ink override (SUCCESS for done, DANGER for errored). */
  readonly color?: string;
}

/** 4-up run-summary strip with an optional `ƒ connector.method` caption row. */
export function StatRow(props: { caption?: ReactNode; stats: readonly Stat[] }): ReactNode {
  const width = `${Math.floor(100 / props.stats.length)}%`;
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{
        marginTop: "24px",
        border: `1px solid ${BORDER}`,
        borderRadius: "8px",
        borderCollapse: "separate",
        overflow: "hidden",
      }}
    >
      <tbody>
        {props.caption ? (
          <tr>
            <td
              colSpan={props.stats.length}
              style={{
                padding: "12px 16px",
                backgroundColor: SURFACE,
                borderBottom: `1px solid ${BORDER}`,
                fontFamily: SANS,
                fontSize: "12.5px",
                color: INK_2,
              }}
            >
              {props.caption}
            </td>
          </tr>
        ) : null}
        <tr>
          {props.stats.map((s, i) => (
            <td
              key={i}
              width={width}
              style={{
                padding: "14px 12px",
                borderRight:
                  i === props.stats.length - 1 ? "none" : `1px solid ${HAIRLINE}`,
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: "19px", color: s.color ?? INK }}>
                {s.value}
              </span>
              <br />
              <span style={{ fontFamily: SANS, fontSize: "11px", color: INK_3 }}>{s.label}</span>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/** Green function chip (`ƒ trigify.enrichProfile`) used in captions. */
export function FnChip(props: { children: ReactNode }): ReactNode {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "11px",
        color: ACCENT,
        backgroundColor: GREEN_TINT,
        border: `1px solid ${GREEN_TINT_BORDER}`,
        borderRadius: "5px",
        padding: "2px 7px",
      }}
    >
      {props.children}
    </span>
  );
}

// ─── List rows (emails #12 preview rows, #13 signals) ────────────────────────

export interface ListRowItem {
  readonly title: string;
  /** Muted second line (signals) — omitted for compact preview rows. */
  readonly subtitle?: string;
  /** Right-aligned chip text ("done", "hot · 92"). */
  readonly chip?: string;
  readonly chipColor?: "success" | "muted";
  /** Mono title (run preview rows) vs sans semibold (signal rows). */
  readonly mono?: boolean;
}

export function ListRows(props: { items: readonly ListRowItem[]; footer?: string }): ReactNode {
  return (
    <>
      {props.items.map((item, i) => (
        <table
          key={i}
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          border={0}
          style={{
            marginTop: i === 0 ? "14px" : "6px",
            border: `1px solid ${item.subtitle ? BORDER : HAIRLINE}`,
            borderRadius: item.subtitle ? "8px" : "6px",
            borderCollapse: "separate",
          }}
        >
          <tbody>
            <tr>
              <td style={{ padding: item.subtitle ? "11px 14px" : "8px 12px" }}>
                <span
                  style={
                    item.mono
                      ? { fontFamily: MONO, fontSize: "12.5px", color: INK }
                      : { fontFamily: SANS, fontSize: "13.5px", fontWeight: 600, color: INK }
                  }
                >
                  {item.title}
                </span>
                {item.subtitle ? (
                  <>
                    <br />
                    <span style={{ fontFamily: SANS, fontSize: "12px", color: INK_2 }}>
                      {item.subtitle}
                    </span>
                  </>
                ) : null}
              </td>
              {item.chip ? (
                <td align="right" style={{ padding: "0 12px 0 0", verticalAlign: "middle" }}>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: item.subtitle ? "11px" : "10.5px",
                      fontWeight: item.subtitle ? 700 : 400,
                      color: item.chipColor === "muted" ? INK_3 : SUCCESS,
                      backgroundColor:
                        item.chipColor === "muted" ? SURFACE_2 : SUCCESS_TINT,
                      border: `1px solid ${
                        item.chipColor === "muted" ? BORDER : SUCCESS_TINT_BORDER
                      }`,
                      borderRadius: "20px",
                      padding: item.subtitle ? "3px 9px" : "2px 8px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.chip}
                  </span>
                </td>
              ) : null}
            </tr>
          </tbody>
        </table>
      ))}
      {props.footer ? (
        <Text
          style={{
            margin: "12px 0 0",
            fontFamily: SANS,
            fontSize: "12.5px",
            color: INK_3,
            textAlign: "center" as const,
          }}
        >
          {props.footer}
        </Text>
      ) : null}
    </>
  );
}

// ─── Numbered steps (email #10) ──────────────────────────────────────────────

export interface Step {
  readonly title: string;
  readonly detail?: ReactNode;
}

export function StepList(props: { steps: readonly Step[] }): ReactNode {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ marginTop: "24px" }}>
      <tbody>
        {props.steps.map((step, i) => (
          <tr key={i}>
            <td width={34} style={{ verticalAlign: "top", paddingTop: i === 0 ? 0 : "12px" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "22px",
                  height: "22px",
                  lineHeight: "22px",
                  textAlign: "center",
                  borderRadius: "50%",
                  backgroundColor: GREEN_TINT,
                  border: `1px solid ${GREEN_TINT_BORDER}`,
                  color: ACCENT,
                  fontFamily: MONO,
                  fontSize: "12px",
                  fontWeight: 700,
                }}
              >
                {i + 1}
              </span>
            </td>
            <td style={{ verticalAlign: "top", paddingTop: i === 0 ? 0 : "12px" }}>
              <span style={{ fontFamily: SANS, fontSize: "14px", fontWeight: 600, color: INK }}>
                {step.title}
              </span>
              {step.detail ? (
                <>
                  <br />
                  <span style={{ fontFamily: SANS, fontSize: "13px", color: INK_2 }}>
                    {step.detail}
                  </span>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Round success badge + eyebrow ("Run complete") for email #12. */
export function SuccessEyebrow(props: { children: ReactNode }): ReactNode {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
      <tbody>
        <tr>
          <td
            width={34}
            height={34}
            align="center"
            style={{
              borderRadius: "50%",
              backgroundColor: SUCCESS_TINT,
              border: `1px solid ${SUCCESS_TINT_BORDER}`,
              fontFamily: SANS,
              fontSize: "16px",
              fontWeight: 700,
              color: SUCCESS,
              lineHeight: "34px",
            }}
          >
            ✓
          </td>
          <td style={{ paddingLeft: "10px" }}>
            <Eyebrow color={SUCCESS}>{props.children}</Eyebrow>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
