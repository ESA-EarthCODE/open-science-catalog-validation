const $RefParser = require("@apidevtools/json-schema-ref-parser");
const fs = require("fs");
const path = require("path");

function getFilesAtDepth(directory, depth = 1, currentDepth = 0, files = []) {
  const items = fs.readdirSync(directory);

  items.forEach((item) => {
    const itemPath = "./" + path.join(directory, item);
    const stats = fs.statSync(itemPath);

    // Check if item is a directory or a file
    if (stats.isDirectory()) {
      // Traverse deeper if it's a directory
      getFilesAtDepth(itemPath, depth, currentDepth + 1, files);
    } else if (currentDepth >= depth) {
      // Add file to list if it's at the required depth
      files.push(itemPath);
    }
  });

  return files;
}

const relativePath = "./schemas";
const depthRequirement = 1; // Minimum depth for files to be included
getFilesAtDepth(relativePath, depthRequirement).forEach(async (file) => {
  try {
    const deref = await $RefParser.dereference(`./${file}`);
    fs.writeFile(file, JSON.stringify(deref), (err) => {
      if (err) console.log(err);
      else {
        console.log(`File written successfully: ${file}`);
      }
    });
  } catch (err) {
    console.error(err);
  }
});
