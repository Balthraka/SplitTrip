// The same theme the page used to set in the browser (`tailwind.config = ...`). Used only by scripts/build-css.mjs.
module.exports = {
  content: [],   // set by scripts/build-css.mjs (the page itself)
  theme: {
    extend: {
      fontFamily: { sans: ['Sora', 'sans-serif'] },
      colors: {
        cream: '#F5F0E8',
        parchment: '#EDE8DF',
        ink: '#1E1B16',
        muted: '#7A7163',
        gold: { DEFAULT: '#C8964C', light: '#F5E6C8', dark: '#9C6F2E' },
        moss: { DEFAULT: '#3D8B5E', light: '#D4EDDF' },
        rose: { DEFAULT: '#C0392B', light: '#FAE0DD' },
      },
    },
  },
};
