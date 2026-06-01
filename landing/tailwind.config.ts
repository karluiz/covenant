import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{astro,html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0c0a",
        mist: "#e8efe6",
        moss: { 400: "#7bd389", 500: "#4fbf6a", 600: "#3aa055" },
        bone: "#f3efe7",
      },
      fontFamily: {
        sans: ["Sansation", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      letterSpacing: { eyebrow: "0.18em" },
      maxWidth: { content: "72rem" },
    },
  },
} satisfies Config;
