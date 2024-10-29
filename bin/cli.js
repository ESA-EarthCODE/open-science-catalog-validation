#!/usr/bin/env node
const { resolve } = require("path");
const { exec } = require("child_process");

exec(
  `npm explore open-science-catalog-validation -- npm run test -- ${process.argv
    .slice(2)
    .map((p) => resolve(p))
    .join(" ")}`,
  (error, stdout) => {
    if (error) {
      console.error("Validation failed!");
      process.exitCode = 1;
    } else {
      console.info("Validation successful!");
    }
    console.log(stdout);
  },
);
