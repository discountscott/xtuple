/*jshint node:true, indent:2, curly:false, eqeqeq:true, immed:true, latedef:true, newcap:true, noarg:true,
regexp:true, undef:true, strict:true, trailing:true, white:true */
/*global _:true */

(function () {
  "use strict";

  var _ = require('underscore'),
    async = require('async'),
    exec = require('child_process').exec,
    fs = require('fs'),
    path = require('path'),
    PEG = require("pegjs"),
    conversionMap = require("./convert_specialized").conversionMap,
    dataSource = require('../../../node-datasource/lib/ext/datasource').dataSource,
    inspectDatabaseExtensions = require("./inspect_database").inspectDatabaseExtensions;

/*
 Given a path to a manifest.js file (and a bunch of other possible options), parse,
 aggregate, and return the sql that's listed in that file.
*/

  // register extension and dependencies
  var getRegistrationSql = function (options, extensionLocation) {
    var registerSql = 'do $notice$ plv8.elog(NOTICE, "About to register extension ' +
      options.name + '"); $notice$ language plv8;\n';

    registerSql = registerSql + "select xt.register_extension('%@', '%@', '%@', '', %@);\n"
      .f(options.name, options.description || options.comment, extensionLocation, options.loadOrder || 9999);

    registerSql = registerSql + "select xt.grant_role_ext('ADMIN', '%@');\n"
      .f(options.name);

    // infer dependencies from package.json -> peerDependencies
    // infer dependencies from manifest.js -> dependencies
    //
    // This is all in an in-betweensy state. The idea was to use npm more for our extensions, which means
    // putting extension metadata in package.json instead of manifest.js. This is a work in progress.
    //
    var isPackageJson = options.xTupleExtensionType === "package";
    var dependencies = (isPackageJson ? _.omit(options.peerDependencies, "xtuple") : options.dependencies) || [];
    _.each(dependencies, function (dependency) {
      var dependencySql = "select xt.register_extension_dependency('%@', '%@');\n"
          .f(options.name, dependency),
        grantDependToAdmin = "select xt.grant_role_ext('ADMIN', '%@');\n"
          .f(dependency);

      registerSql = registerSql + dependencySql + grantDependToAdmin;
    });
    return registerSql;
  };

  var composeExtensionSql = function (scriptSql, packageFile, options, callback) {
    // each string of the scriptContents is the concatenated SQL for the script.
    // join these all together into a single string for the whole extension.
    var extensionSql = _.reduce(scriptSql, function (memo, script) {
      return memo + script;
    }, "");

    if (options.registerExtension) {
      extensionSql = getRegistrationSql(packageFile, options.extensionLocation) +
        extensionSql;
    }

    if (options.wipeViews) {
      // If we want to pre-emptively wipe out the views, the best place to do it
      // is at the start of the core application code
      fs.readFile(path.join(__dirname, "../../../database/source/wipe_views.sql"),
          function (err, wipeSql) {
        if (err) {
          callback(err);
          return;
        }
        extensionSql = wipeSql + extensionSql;
        callback(null, extensionSql);
      });

    } else if (options.wipeOrms) {
      // If we want to pre-emptively wipe out the views, the best place to do it
      // is at the start of the core application code
      fs.readFile(path.join(__dirname, "../../../database/source/delete_system_orms.sql"),
          function (err, wipeSql) {
        if (err) {
          callback(err);
          return;
        }
        extensionSql = wipeSql + extensionSql;
        callback(null, extensionSql);
      });
    } else {
      callback(null, extensionSql);
    }
  };

  var explodeManifest = function (options, manifestCallback) {
    var manifestFilename = options.manifestFilename;
    var packageJson;
    var dbSourceRoot = path.dirname(manifestFilename);

    if (options.extensionPath && fs.existsSync(path.resolve(options.extensionPath, "package.json"))) {
      packageJson = require(path.resolve(options.extensionPath, "package.json"));
      packageJson.xTupleExtensionType = "package";
    }
    //
    // Step 1:
    // Read the manifest files.
    //

    if (!fs.existsSync(manifestFilename) && packageJson) {
      console.log("No manifest file " + manifestFilename + ". There is probably no db-side code in the extension.");
      composeExtensionSql([], packageJson, options, manifestCallback);
      return;

    } else if (!fs.existsSync(manifestFilename)) {
      // error condition: no manifest file
      X.err("Cannot install/update extension located at: ", manifestFilename);
      X.warn("Skipping install/update. You should probably look into why this extension is missing.");
      manifestCallback(null, "");
      return;
    }
    fs.readFile(manifestFilename, "utf8", function (err, manifestString) {
      var manifest,
        databaseScripts,
        extraManifestPath,
        defaultSchema,
        parsingExpressionGrammars,
        extraManifest,
        extraManifestScripts,
        alterPaths = dbSourceRoot.indexOf("foundation-database") < 0;

      try {
        manifest = JSON.parse(manifestString);
        manifest.xTupleExtensionType = "manifest";
        databaseScripts = manifest.databaseScripts;
        defaultSchema = manifest.defaultSchema;
        parsingExpressionGrammars = manifest.parsingExpressionGrammars ? manifest.parsingExpressionGrammars : [];

      } catch (error) {
        // error condition: manifest file is not properly formatted
        manifestCallback("Manifest is not valid JSON" + manifestFilename + " ERROR: " + error);
        return;
      }

      var savePEGparser = function (pegInfo, callback) {
        // Get the *.peg file.
        fs.readFile(path.join(dbSourceRoot, pegInfo.pegPath), "utf8", function (err, data) {
            // Generate the parser.
            var jsFileString = "",
                parser = PEG.buildParser(data, {output: 'source'});

            // Create the parser text install_js file text.
            jsFileString += "select xt.install_js('" + pegInfo.nameSpace + "', '" + pegInfo.type + "', '" + pegInfo.context + "',  $parser$\n" +
                            "\n" +
                            "/**\n" +
                            " * WARNING!!! IMPORTANT!!! README!!!\n" +
                            " * \n" +
                            " * The file was GENERATED! None of this file was written by a human.\n" +
                            " * DO NOT EDIT this file!\n" +
                            " * This file was created by running build_app.js in the process_manifext.js file.\n" +
                            " * If you find a bug or need to extend it with a new feature, you MUST follow this process:\n" +
                            " * \n" +
                            " * 1. Modify the PEG Grammer definition at: " + pegInfo.pegPath + "\n" +
                            " * 2. Use the PEG.js online tool to test the new grammer:\n" +
                            " *    - http://pegjs.org/online\n" +
                            " * 3. Run build_app.js with your PEG Grammer change and git commit the modified files.\n" +
                            " */\n\n" +
                            "(function () {\n" +
                            pegInfo.nameSpace + "." + pegInfo.type + " = {};\n" +
                            pegInfo.nameSpace + "." + pegInfo.type + ".parser = ";
            jsFileString += parser + ";\n\n";
            jsFileString += "})();\n" +
                            "\n" +
                            "$parser$ );\n";

            // Save the parser install_js file to the file system.
            fs.writeFile(path.join(dbSourceRoot, pegInfo.javascriptPath), jsFileString, "utf8", function (err) {
              if (err) {
                throw err;
              }
              console.log('Saved PEGjs parser Javascript to ', pegInfo.javascriptPath);
              callback();
            });
          }
        );
      };

      async.eachSeries(parsingExpressionGrammars, savePEGparser, function (err) {
        if (err) {
          manifestCallback("Cannot save PEGjs parser Javascript. ERROR = " + err);
        }
      });

      //
      // Step 2:
      //

      // supported use cases:

      // 1. add mobilized inventory to quickbooks
      // need the frozen_manifest, the foundation/manifest, and the mobile manifest
      // -e ../private-extensions/source/inventory -f
      // useFrozenScripts, useFoundationScripts

      // 2. add mobilized inventory to masterref (foundation inventory is already there)
      // need the the foundation/manifest and the mobile manifest
      // -e ../private-extensions/source/inventory
      // useFoundationScripts

      // 3. add unmobilized inventory to quickbooks
      // need the frozen_manifest and the foundation/manifest
      // -e ../private-extensions/source/inventory/foundation-database -f
      // useFrozenScripts (useFoundationScripts already taken care of by -e path)

      // 4. upgrade unmobilized inventory
      // not sure if this is necessary, but it would look like
      // -e ../private-extensions/source/inventory/foundation-database

      //
      // Foundation means plv8-free. Only relevant for the core, and for the three commercial
      // extensions that we've ported into this process. Once everyone is on the xtuple server
      // we can merge all the `foundation-database` code into `database` and remove the
      // concept of foundation-ness
      //
      if (options.useFoundationScripts) {
        extraManifest = JSON.parse(fs.readFileSync(path.join(dbSourceRoot, "../../foundation-database/manifest.js")));
        defaultSchema = defaultSchema || extraManifest.defaultSchema;
        extraManifestScripts = extraManifest.databaseScripts;
        extraManifestScripts = _.map(extraManifestScripts, function (script) {
            var scriptPath;

            if (typeof script === 'object' && script.path) {
              scriptPath = script.path;
            } else {
              scriptPath = script;
            }
          return "../../foundation-database/" + scriptPath;
        });
        databaseScripts.unshift(extraManifestScripts);
        databaseScripts = _.flatten(databaseScripts);
      }
      //
      // Frozen means non-idempotent. Only exists for foundation code, and is mostly for table definitions.
      // As soon as we rewrite all this code to be idempotent we can remove the concept of frozen-ness
      // Note that will also remove the distinction between installer installs and installer updates.
      //
      if (options.useFrozenScripts) {
        // Frozen files are not idempotent and should only be run upon first registration
        extraManifestPath = alterPaths ?
         path.join(dbSourceRoot, "../../foundation-database/frozen_manifest.js") :
         path.join(dbSourceRoot, "frozen_manifest.js");

        extraManifest = JSON.parse(fs.readFileSync(extraManifestPath));
        defaultSchema = defaultSchema || extraManifest.defaultSchema;
        extraManifestScripts = extraManifest.databaseScripts;
        if (alterPaths) {
          extraManifestScripts = _.map(extraManifestScripts, function (script) {
            var scriptPath;

            if (typeof script === 'object' && script.path) {
              scriptPath = script.path;
            } else {
              scriptPath = script;
            }
            return "../../foundation-database/" + scriptPath;
          });
        }
        databaseScripts.unshift(extraManifestScripts);
        databaseScripts = _.flatten(databaseScripts);
      }

      //
      // Step 3:
      // Concatenate together all the files referenced in the manifest.
      //
      var getScriptSql = function (script, scriptCallback) {
        var fullFilename,
            filename,
            topsep = "Error in manifest ",
            botsep;

        for (var i = topsep.length; i < 80; i += 5) topsep += "vvvvv"
        botsep = topsep.replace(/v/g, "^");

        if (typeof script === 'object' && script.path) {
          filename = script.path;
        } else {
          filename = script;
        }

        fullFilename = path.join(dbSourceRoot, filename);

        if (!fs.existsSync(fullFilename)) {
          // error condition: script referenced in manifest.js isn't there
          scriptCallback([topsep, path.join(dbSourceRoot, filename) + " does not exist", botsep].join("\n"));
          return;
        }
        fs.readFile(fullFilename, "utf8", function (err, scriptContents) {
          // error condition: can't read script
          if (err) {
            scriptCallback([topsep, err, botsep].join("\n"));
            return;
          }
          var beforeNoticeSql = "do $notice$ BEGIN RAISE NOTICE 'Loading file " + path.basename(fullFilename) +
              "'; END $notice$ language plpgsql;\n",
            extname = path.extname(fullFilename).substring(1);

          // convert special files: metasql, uiforms, reports, uijs
          scriptContents = conversionMap[extname](scriptContents, fullFilename, defaultSchema, script);

          //
          // Incorrectly-ended sql files (i.e. no semicolon) make for unhelpful error messages
          // when we concatenate 100's of them together. Guard against these, even if it throws
          // some false postitives when for example a file ends in a comment.
          //
          scriptContents = scriptContents.trim();
          if (scriptContents.charAt(scriptContents.length - 1) !== ';') {
            // error condition: script is improperly formatted
            scriptCallback([topsep, "Error: " + fullFilename + " contents do not end in a semicolon.", botsep].join("\n"));
          }

          scriptCallback(null, "\n" + "-- Script File Location: " + fullFilename + "\n" + scriptContents);
        });
      };
      async.mapSeries(databaseScripts || [], getScriptSql, function (err, scriptSql) {
        var registerSql,
          dependencies;

        if (err) {
          manifestCallback(err);
          return;
        }

        composeExtensionSql(scriptSql, packageJson || manifest, options, manifestCallback);
      });
      //
      // End script installation code
      //
    });
  };

  exports.explodeManifest = explodeManifest;
}());
