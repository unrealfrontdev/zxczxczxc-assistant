/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      typography: (theme) => ({
        invert: {
          css: {
            "--tw-prose-body":       theme("colors.white / 85%"),
            "--tw-prose-headings":   theme("colors.white"),
            "--tw-prose-lead":       theme("colors.white / 70%"),
            "--tw-prose-links":      theme("colors.blue.400"),
            "--tw-prose-bold":       theme("colors.white"),
            "--tw-prose-counters":   theme("colors.white / 50%"),
            "--tw-prose-bullets":    theme("colors.white / 40%"),
            "--tw-prose-hr":         theme("colors.white / 15%"),
            "--tw-prose-quotes":     theme("colors.white / 80%"),
            "--tw-prose-code":       theme("colors.blue.300"),
            "--tw-prose-pre-code":   theme("colors.white / 90%"),
            "--tw-prose-pre-bg":     "rgba(0,0,0,0.4)",
            "--tw-prose-th-borders": theme("colors.white / 20%"),
            "--tw-prose-td-borders": theme("colors.white / 10%"),
          },
        },
      }),
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
