/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/client/**/*.{ts,tsx}"],
  theme: {
    // Replaced, not extended: off-scale sizes stop existing as utilities.
    fontSize: {
      xs: ["12px", { lineHeight: "16px" }],
      sm: ["14px", { lineHeight: "20px" }],
      base: ["16px", { lineHeight: "24px" }],
      lg: ["20px", { lineHeight: "28px" }],
      xl: ["24px", { lineHeight: "32px" }],
      "2xl": ["32px", { lineHeight: "40px" }],
      "3xl": ["48px", { lineHeight: "56px" }],
    },
    fontWeight: {
      normal: "400",
      medium: "500",
      semibold: "600",
    },
    borderRadius: {
      none: "0",
      DEFAULT: "6px",
      sm: "6px",
      md: "12px",
      full: "9999px",
    },
    boxShadow: {
      1: "var(--shadow-1)",
      2: "var(--shadow-2)",
      none: "none",
    },
    extend: {
      // Color roles from index.css; both themes redefine the underlying vars.
      colors: {
        surface: "var(--surface)",
        "surface-raised": "var(--surface-raised)",
        border: "var(--border)",
        text: "var(--text)",
        muted: "var(--text-muted)",
        accent: "var(--accent)",
        "accent-text": "var(--accent-text)",
        danger: "var(--danger)",
        success: "var(--success)",
        warning: "var(--warning)",
        scrim: "var(--scrim)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
      },
      transitionTimingFunction: {
        DEFAULT: "var(--ease)",
      },
      animation: {
        "slide-in": "slideIn var(--duration-base) var(--ease)",
        "slide-up": "slideUp var(--duration-base) var(--ease)",
      },
      // Minimum hit target for touch (WCAG 2.5.8 / Apple HIG).
      minHeight: { touch: "44px" },
      minWidth: { touch: "44px" },
      fontFamily: {
        // Cockpit Grid numerals; falls back to the platform monospace stack.
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
