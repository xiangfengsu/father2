import { join, extname, relative, resolve, dirname } from "path";
import { existsSync, readFileSync, statSync } from "fs";
import vfs from "vinyl-fs";
import signale from "signale";
import rimraf from "rimraf";
import through from "through2";
import slash from "slash2";
import chalk from "chalk";
import * as chokidar from "chokidar";
import * as babel from "@babel/core";
import gulpTs from "gulp-typescript";

import less from "less";
import sass from "node-sass";
import NpmImport from "less-plugin-npm-import";
import gulpIf from "gulp-if";
import getBabelConfig from "./getBabelConfig";
import { IBundleOptions } from "./types";

const postcss = require("postcss");
const rucksack = require("rucksack-css");
const autoprefixer = require("autoprefixer");

interface IBabelOpts {
  cwd: string;
  type: "esm" | "cjs";
  target?: "browser" | "node";
  watch?: boolean;
  importLibToEs?: boolean;
  bundleOpts: IBundleOptions;
}

interface ITransformOpts {
  file: {
    contents: string;
    path: string;
  };
  type: "esm" | "cjs";
}

export default async function(opts: IBabelOpts) {
  const {
    cwd,
    type,
    watch,
    importLibToEs,
    bundleOpts: {
      baseSrc = "src",
      target = "browser",
      runtimeHelpers,
      extraBabelPresets = [],
      extraBabelPlugins = [],
      browserFiles = [],
      nodeFiles = [],
      disableTypeCheck
    }
  } = opts;
  const srcPath = join(cwd, baseSrc);
  const targetDir = type === "esm" ? "es" : "lib";
  const targetPath = join(cwd, targetDir);

  signale.info(`Clean ${targetDir} directory`);
  rimraf.sync(targetPath);

  function transform(opts: ITransformOpts) {
    const { file, type } = opts;
    signale.info(
      `[${type}] Transform: ${slash(file.path).replace(`${cwd}/`, "")}`
    );

    const babelOpts = getBabelConfig({
      target,
      type,
      typescript: true,
      runtimeHelpers,
      filePath: relative(cwd, file.path),
      browserFiles,
      nodeFiles
    });
    if (importLibToEs && type === "esm") {
      babelOpts.plugins.push(require.resolve("../lib/importLibToEs"));
    }
    babelOpts.presets.push(...extraBabelPresets);
    babelOpts.plugins.push(...extraBabelPlugins);

    return babel.transform(file.contents, {
      ...babelOpts,
      filename: file.path
    }).code;
  }

  function getTSConfig() {
    const tsconfigPath = join(cwd, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      return (
        JSON.parse(readFileSync(tsconfigPath, "utf-8")).compilerOptions || {}
      );
    } else {
      return {};
    }
  }

  function cssInjection(content) {
    return content
      .replace(/\/style\/?'/g, "/style/css'")
      .replace(/\/style\/?"/g, '/style/css"')
      .replace(/\.scss/g, ".css")
      .replace(/\.less/g, ".css");
  }

  function transformLess(lessFile) {
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
    const resolvedLessFile = resolve(cwd, lessFile);

    let data = readFileSync(resolvedLessFile, "utf-8");
    data = data.replace(/^\uFEFF/, "");

    // Do less compile
    const lessOpts = {
      paths: [dirname(resolvedLessFile)],
      filename: resolvedLessFile,
      plugins: [new NpmImport({ prefix: "~" })],
      javascriptEnabled: true
    };
    return less
      .render(data, lessOpts)
      .then(result =>
        postcss(postcssConfig.plugins).process(result.css, { from: undefined })
      )
      .then(r => r.css);
  }

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
    const resolvedSassFile = resolve(cwd, sassFile);

    let data = readFileSync(resolvedSassFile, "utf-8");
    data = data.replace(/^\uFEFF/, "");
    return new Promise((resv, reject) => {
      sass.render(
        {
          data,
          includePaths: [dirname(resolvedSassFile)]
        },
        (error, result) => {
          if (!error) {
            postcss(postcssConfig.plugins)
              .process(result.css, {
                from: undefined
              })
              .then(r => resv(r.css));
          } else {
            reject(error);
          }
        }
      );
    });
    // return
  }
  function createStream(src) {
    const tsConfig = getTSConfig();
    const babelTransformRegexp = disableTypeCheck ? /\.(t|j)sx?$/ : /\.jsx?$/;
    return vfs
      .src(src, {
        allowEmpty: true,
        base: srcPath
      })
      .pipe(
        gulpIf(
          f => !disableTypeCheck && /\.tsx?$/.test(f.path),
          gulpTs(tsConfig)
        )
      )
      .pipe(
        gulpIf(
          f => /\.less$/.test(f.path),
          through.obj(function(file, env, cb) {
            try {
              this.push(file.clone());
              if (file.path.match(/(\/|\\)style(\/|\\)index\.less$/)) {
                transformLess(file.path)
                  .then(css => {
                    file.contents = Buffer.from(css);
                    file.path = file.path.replace(/\.less$/, ".css");
                    this.push(file);
                    cb(null);
                  })
                  .catch(e => {
                    console.error(e);
                  });
              } else {
                cb(null);
              }
            } catch (error) {
              signale.error(`Compiled less to css faild: ${file.path}`);
              cb(null);
            }
          })
        )
      )
      .pipe(
        gulpIf(
          f => /\.scss$/.test(f.path),
          through.obj(function(file, env, cb) {
            try {
              this.push(file.clone());
              if (file.path.match(/(\/|\\)style(\/|\\)index\.scss$/)) {
                transformSass(file.path)
                  .then(css => {
                    file.contents = Buffer.from(css as string);
                    file.path = file.path.replace(/\.scss$/, ".css");
                    this.push(file);
                    cb(null);
                  })
                  .catch(e => {
                    console.error(e);
                  });
              } else {
                cb(null);
              }
            } catch (error) {
              signale.error(
                `Compiled scss to css faild: ${file.path} ${error}`
              );
              cb(null);
            }
          })
        )
      )
      .pipe(
        gulpIf(
          f => babelTransformRegexp.test(f.path),
          through.obj(function(file, env, cb) {
            try {
              file.contents = Buffer.from(
                transform({
                  file,
                  type
                })
              );
              // .jsx -> .js
              file.path = file.path.replace(extname(file.path), ".js");
              // style/index.js -> style/css.js
              if (file.path.match(/(\/|\\)style(\/|\\)index\.js/)) {
                this.push(file.clone());
                const content = file.contents.toString(env);
                file.contents = Buffer.from(cssInjection(content));
                file.path = file.path.replace(/index\.js/, "css.js");
                this.push(file);
              }
              cb(null, file);
            } catch (e) {
              signale.error(`Compiled faild: ${file.path}`);
              cb(null);
            }
          })
        )
      )
      .pipe(vfs.dest(targetPath));
  }

  return new Promise(resolve => {
    createStream([
      join(srcPath, "**/*"),
      `!${join(srcPath, "**/fixtures/**/*")}`,
      `!${join(srcPath, "**/templates/**/*")}`,
      `!${join(srcPath, "**/__test__/*.+(test|e2e|spec).+(js|jsx|ts|tsx)")}`,
      `!${join(srcPath, "**/*.mdx")}`,
      `!${join(srcPath, "**/*.d.ts")}`,
      `!${join(srcPath, "**/*.+(test|e2e|spec).+(js|jsx|ts|tsx)")}`
    ]).on("end", () => {
      if (watch) {
        signale.info("Start watch", srcPath);
        chokidar
          .watch(srcPath, {
            ignoreInitial: true
          })
          .on("all", (event, fullPath) => {
            const relPath = fullPath.replace(srcPath, "");
            signale.info(`[${event}] ${join(srcPath, relPath)}`);
            if (!existsSync(fullPath)) return;
            if (statSync(fullPath).isFile()) {
              createStream([fullPath]);
            }
          });
      }
      resolve();
    });
  });
}
