const { join, extname, relative, resolve, dirname } = require("path");
const { existsSync, readFileSync, statSync, writeFile } = require("fs");
const sass = require("node-sass");

const postcss = require("postcss");
const rucksack = require("rucksack-css");
const autoprefixer = require("autoprefixer");

function transformSass(sassFile) {
  const postcssConfig = {
    plugins: [
      rucksack(),
      autoprefixer({
        browsers: [
          "last 2 versions",
          "Firefox ESR",
          "> 1%",
          "ie >= 9",
          "iOS >= 8",
          "Android >= 4"
        ]
      })
    ]
  };
  const resolvedSassFile = resolve(process.cwd(), sassFile);

  let data = readFileSync(resolvedSassFile, "utf-8");
  data = data.replace(/^\uFEFF/, "");

  return new Promise((resolve, reject) => {
    sass.render(
      {
        data
      },
      (error, result) => {
        if (!error) {
          postcss(postcssConfig.plugins)
            .process(result.css, {
              from: undefined
            })
            .then(r => resolve(r.css));
        } else {
          reject(error);
        }
      }
    );
  });
}

transformSass("./index.scss")
  .then(css => {
    const contents = Buffer.from(css);
       console.log(contents);
    writeFile("index.css", contents, "binary", function(err) {
      console.log(err);
    });
  })
  .catch(e => {
    console.error(e);
  });
