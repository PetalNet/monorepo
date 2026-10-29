/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#faf5ff",
          100: "#f3e8ff",
          200: "#e9d5ff",
          300: "#d8b4fe",
          400: "#c084fc",
          500: "#a855f7",
          600: "#9333ea",
          700: "#7c5dfa",
          800: "#6b21a8",
          900: "#581c87",
        },
        accent: {
          500: "#9b6bff",
        },
        dark: {
          900: "#2a1748",
          800: "#40246b",
          700: "#3e2a75",
          600: "#5731a5",
          500: "#5533a5",
        },
        success: {
          bg: "rgba(34, 197, 94, 0.1)",
          text: "#15803d",
        },
        warning: {
          bg: "rgba(251, 191, 36, 0.1)",
          text: "#d97706",
        },
        danger: {
          bg: "rgba(239, 68, 68, 0.1)",
          text: "#dc2626",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        brand: ["Lexend", "Inter", "sans-serif"],
      },
      backgroundImage: {
        "app-gradient":
          "linear-gradient(180deg, #f8f5ff 0%, #fdfcff 35%, #f7fcff 100%)",
        "primary-gradient": "linear-gradient(135deg, #7c5dfa, #9b6bff)",
      },
      boxShadow: {
        card: "0 20px 40px rgba(60, 35, 110, 0.08)",
        "card-hover": "0 25px 40px rgba(66, 32, 121, 0.12)",
        "card-lg": "0 18px 36px rgba(59, 33, 110, 0.1)",
        "card-sm": "0 18px 32px rgba(66, 32, 121, 0.08)",
        button: "0 18px 30px rgba(95, 61, 170, 0.25)",
      },
    },
  },
  plugins: [],
};
