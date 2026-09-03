/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "on-secondary-fixed-variant": "#464747",
        "on-error": "#690005",
        "primary-container": "#e2e2e2",
        "on-error-container": "#ffdad6",
        "on-surface": "#e5e2e1",
        "on-primary-fixed-variant": "#454747",
        "on-tertiary-container": "#636374",
        "surface": "#131313",
        "on-tertiary": "#2f2f3f",
        "on-primary": "#2f3131",
        "outline-variant": "#444748",
        "surface-container-highest": "#353534",
        "on-secondary": "#2f3131",
        "primary": "#ffffff",
        "surface-container-low": "#1c1b1b",
        "inverse-primary": "#5d5f5f",
        "primary-fixed": "#e2e2e2",
        "outline": "#8e9192",
        "on-surface-variant": "#c4c7c8",
        "secondary-fixed": "#e3e2e2",
        "secondary-container": "#484949",
        "primary-fixed-dim": "#c6c6c7",
        "on-background": "#e5e2e1",
        "tertiary-container": "#e3e0f5",
        "secondary": "#c7c6c6",
        "surface-container": "#201f1f",
        "tertiary": "#ffffff",
        "surface-variant": "#353534",
        "on-tertiary-fixed": "#1a1a29",
        "tertiary-fixed": "#e3e0f5",
        "background": "#131313",
        "surface-tint": "#c6c6c7",
        "surface-container-high": "#2a2a2a",
        "surface-dim": "#131313",
        "on-primary-container": "#636565",
        "surface-container-lowest": "#0e0e0e",
        "error-container": "#93000a",
        "inverse-surface": "#e5e2e1",
        "on-secondary-fixed": "#1a1c1c",
        "secondary-fixed-dim": "#c7c6c6",
        "on-tertiary-fixed-variant": "#454556",
        "on-secondary-container": "#b8b8b8",
        "error": "#ffb4ab",
        "tertiary-fixed-dim": "#c6c4d9",
        "on-primary-fixed": "#1a1c1c",
        "inverse-on-surface": "#313030",
        "surface-bright": "#3a3939"
      },
      borderRadius: {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
      spacing: {
        "xxl": "128px",
        "unit": "4px",
        "gutter": "24px",
        "md": "16px",
        "lg": "32px",
        "margin-safe": "48px",
        "sm": "8px",
        "xl": "64px",
        "xs": "4px"
      },
      fontFamily: {
        "body-md": ["Inter", "sans-serif"],
        "label-caps": ["JetBrains Mono", "monospace"],
        "headline-sm": ["Manrope", "sans-serif"],
        "body-sm": ["Inter", "sans-serif"],
        "display-lg": ["Manrope", "sans-serif"],
        "headline-lg-mobile": ["Manrope", "sans-serif"],
        "headline-lg": ["Manrope", "sans-serif"]
      },
      fontSize: {
        "body-md": ["16px", { lineHeight: "1.6", letterSpacing: "-0.01em", fontWeight: "400" }],
        "label-caps": ["11px", { lineHeight: "1.2", letterSpacing: "0.15em", fontWeight: "500" }],
        "headline-sm": ["18px", { lineHeight: "1.4", letterSpacing: "0.1em", fontWeight: "500" }],
        "body-sm": ["14px", { lineHeight: "1.6", letterSpacing: "0", fontWeight: "400" }],
        "display-lg": ["64px", { lineHeight: "1.1", letterSpacing: "-0.04em", fontWeight: "200" }],
        "headline-lg-mobile": ["24px", { lineHeight: "1.2", letterSpacing: "0.02em", fontWeight: "300" }],
        "headline-lg": ["32px", { lineHeight: "1.2", letterSpacing: "0.05em", fontWeight: "300" }]
      }
    }
  },
  plugins: []
}
