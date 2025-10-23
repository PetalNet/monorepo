/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        "theater-dark": "#0a0a0f",
        "theater-darker": "#050508",
        "theater-purple": "#8b5cf6",
        "theater-gold": "#fbbf24",
        "theater-silver": "#d1d5db",
        "theater-bronze": "#c87941",
      },
    },
  },
  plugins: [],
};
