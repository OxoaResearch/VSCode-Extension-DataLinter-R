// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import axios from "axios";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

interface LintInput {
  isCodeAvailable: boolean;
  isDataAvailable: boolean;
  dataVariableName?: string;

}

interface LintResult {
  status: string;
  linter: string;
  severity: string;
  scope: string;
  message: string;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "datalinter-r-cli-runner" is now active!');

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand("r-server-runner.runTool", async () => {
    // The code you place here will be executed every time your command is executed

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selectedCode = editor.document.getText(editor.selection);
    if (!selectedCode || selectedCode.trim().length === 0) {
      //prerequsites: code is selected
      showErrorMessageToast("Please select some R code first.");
      return;
    }

    // --- Method : Terminal + Temp File ---
    let terminal = undefined;

    // Prefer the R terminal (e.g. "R Interactive" spawned by the R extension) if it exists
    const rTerminal = vscode.window.terminals.find(t => {
      const name = t.name.toLowerCase();
      return name === "r interactive" || name === "r" || name.startsWith("r ");
    });

    if (rTerminal) {
      terminal = rTerminal;
    }

    if (!terminal) {
      const errorMessage = "No active terminal found. Please start an R session in the terminal.";
      showErrorMessageToast(errorMessage);
      return;
    }

    // Create a temporary file path to store the CSV output
    const tempFile = path.join(os.tmpdir(), `r_var_${Date.now().toString()}.csv`); //TODO: use the .vscode folder to store the temp file
    const rSafePath = tempFile.replace(/\\/g, "/");
    const doneFile = `${tempFile}.done`;
    const rSafeDonePath = doneFile.replace(/\\/g, "/");
    //vscode.window.showInformationMessage("temp file is: " + tempFile);

    const lintInput = await detectWhatToLint(selectedCode);

    let infoMessage = `Linting code: ${lintInput.isCodeAvailable ? "Yes" : "No"}, data: ${lintInput.isDataAvailable ? "Yes" : "No"}`;
    if (lintInput.isDataAvailable) {
      infoMessage += `, data variable name: ${lintInput.dataVariableName}`;
    }
    showInformationMessageToast(infoMessage);
    sendWarningMessageToTerminal(terminal, infoMessage);

    if (!lintInput.isCodeAvailable && !lintInput.isDataAvailable) {
      const errorMessage = "The selection contains no valid code or data to parse";
      showErrorMessageToast(errorMessage);
      sendErrorMessageToTerminal(terminal, errorMessage);
      return;
    }

    let dataVariableValue: string | undefined = undefined;
    let data_type: string | undefined = undefined;

    if (lintInput.isDataAvailable) {
      // Send command to the active terminal to write the dataframe to the temporary CSV file, then write a marker file when done (including error status)
      terminal.sendText(
        `tryCatch({ write.csv(${lintInput.dataVariableName}, '${rSafePath}', row.names=FALSE); writeLines('done', '${rSafeDonePath}') }, error = function(e) { message("Error extracting variable: ", e$message); writeLines(paste0('error:', e$message), '${rSafeDonePath}') })`
      );


      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Retrieving dataset '${lintInput.dataVariableName}' from R...`,
          cancellable: false
        },
        async () => {
          return new Promise<void>((resolve) => {
            let retries = 0;
            const interval = setInterval(() => {
              if (fs.existsSync(doneFile)) {
                clearInterval(interval);
                try {
                  const doneContent = fs.readFileSync(doneFile, "utf8").trim();
                  if (doneContent.startsWith("error:")) {
                    const rError = doneContent.substring(6);
                    const errorMessage = `R Error extracting variable '${lintInput.dataVariableName}': ${rError}`;
                    showErrorMessageToast(errorMessage);
                    sendErrorMessageToTerminal(terminal, errorMessage);

                    // Cleanup files if they exist
                    if (fs.existsSync(doneFile)) {
                      fs.unlinkSync(doneFile);
                    }
                    if (fs.existsSync(tempFile)) {
                      fs.unlinkSync(tempFile);
                    }
                    resolve();
                    return;
                  }

                  // Read the generated CSV and delete the temp file and the marker file
                  dataVariableValue = fs.readFileSync(tempFile, "utf8");
                  fs.unlinkSync(tempFile);
                  fs.unlinkSync(doneFile);
                  data_type = "dataset";
                  resolve();
                } catch (e) {
                  console.error(e);
                  resolve();
                }
              } else if (retries > 1200) {
                // Timeout after 10 minutes (1200 * 500ms) to support large files
                clearInterval(interval);
                const errorMessage = `Timeout loading dataset from R variable ${lintInput.dataVariableName}.`;
                showErrorMessageToast(errorMessage);
                sendErrorMessageToTerminal(terminal, errorMessage);
                resolve();
              }
              retries++;
            }, 500);
          });
        }
      );
    }

    const config = vscode.workspace.getConfiguration("rServerRunner");
    const url = config.get<string>("serverUrl") || "http://localhost:10000/api/lint";

    const body = {
      linter_input: {
        options: {
          show_na: true,
          show_passing: true,
          show_stats: true,
          output_type: "text",
          pretty_print: false
        },
        context: {
          data_header: true,
          data_delim: ",",
          data_type,
          data: dataVariableValue,
          code: lintInput.isCodeAvailable ? selectedCode : undefined,
          linters: ["all"]
        }
      }
    };

    // Show a progress notification
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Sending code to Data Linter for R Server...",
        cancellable: false
      },
      async () => {
        try {
          // Send the POST request
          const response = await axios.post(url, body);

          // Display results in a Webview
          const panel = vscode.window.createWebviewPanel("rResult", "R Server Output", vscode.ViewColumn.Beside, { enableScripts: true });

          const displayContent = typeof response.data === "object" ? JSON.stringify(response.data?.linting_output, null, 2) : response.data?.linting_output;

          const results = parseLintOutput(displayContent);
          panel.webview.html = getWebviewContent(results);
        } catch (error: any) {
          const errorMessage = `Server Error: ${error.message}`;
          showErrorMessageToast(errorMessage);
          sendErrorMessageToTerminal(terminal, errorMessage);
        }
      }
    );
  });

  context.subscriptions.push(disposable);
}

function showErrorMessageToast(text: string) {
  vscode.window.showErrorMessage(text);
}

function sendErrorMessageToTerminal(terminal: vscode.Terminal, text: string) {
  terminal.sendText(`message("\x1b[31m${text}\x1b[0m")`);
}

function showWarningMessageToast(text: string) {
  vscode.window.showWarningMessage(text);
}

function sendWarningMessageToTerminal(terminal: vscode.Terminal, text: string) {
  terminal.sendText(`message("\x1b[33m${text}\x1b[0m")`);
}

function showInformationMessageToast(text: string) {
  vscode.window.showInformationMessage(text);
}

function sendInformationMessageToTerminal(terminal: vscode.Terminal, text: string) {
  terminal.sendText(`message("\x1b[32m${text}\x1b[0m")`);
}


async function detectWhatToLint(selectedCode: string): Promise<LintInput> {

  const parsedSelection = await parseSelection(selectedCode);

  let isDataAvailable = false;
  let isCodeAvailable = false;

  if (parsedSelection == undefined) {
    //TODO display an error message: "The selection contains no valid code or data to parse"
    return {
      isCodeAvailable,
      isDataAvailable
    }
  }

  isDataAvailable = (parsedSelection.isVariableNameOnly && !!parsedSelection.isDefinedVariableName) || !!parsedSelection.containsDataKeyword;
  const dataVariableName = parsedSelection.variableName;

  isCodeAvailable = !parsedSelection.isVariableNameOnly; //means the selection code is more than just a variable name, whether it contains 'data' or not

  return {
    isCodeAvailable,
    isDataAvailable,
    dataVariableName
  }

}

interface ParsedSelection {
  isVariableNameOnly: boolean;
  variableName: string | undefined;
  isDefinedVariableName: boolean | undefined;
  containsDataKeyword: boolean | undefined;
}

async function parseSelection(selectedCode: string): Promise<ParsedSelection | undefined> {
  const regexVariableNameOnly = /\s*(\w+)\s*/;
  const matchVariableNameOnlyResult = selectedCode.match(regexVariableNameOnly);
  if (matchVariableNameOnlyResult == null) {
    return undefined;
  }

  let variableName: string | undefined = matchVariableNameOnlyResult[1];

  const isVariableNameOnly = selectedCode.trim() === variableName;

  if (isVariableNameOnly) {
    const isDefinedVariableName = await isVariableNameDefinedInRWorkspace(variableName!);
    return {
      isVariableNameOnly,
      variableName,
      isDefinedVariableName,
      containsDataKeyword: false
    }
  }



  const regexData = /data\s*\t*=\s*\t*(\w+)/m;
  const matchDataResult = selectedCode.match(regexData);
  variableName = matchDataResult?.[1] ?? undefined;

  if (matchDataResult === null) {
    return {
      isVariableNameOnly,
      variableName,
      isDefinedVariableName: undefined,
      containsDataKeyword: false,
    }
  }

  const isDefinedVariableName = await isVariableNameDefinedInRWorkspace(variableName!);
  return {
    isVariableNameOnly,
    variableName,
    isDefinedVariableName: isDefinedVariableName,
    containsDataKeyword: true,
  }
}

async function isVariableNameDefinedInRWorkspace(variableName: string): Promise<boolean> {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    variableName
  );
  const isDefined = symbols?.some(s => s.name === variableName);
  return isDefined;
}
// This method is called when your extension is deactivated
export function deactivate() { }



function parseLintOutput(output: string): LintResult[] {
  if (!output) {
    return [];
  }

  // Clean up leading/trailing quotes if it was JSON stringified
  let cleanOutput = output.trim();
  if (cleanOutput.startsWith('"') && cleanOutput.endsWith('"')) {
    cleanOutput = cleanOutput.slice(1, -1);
  }

  const lines = cleanOutput.split(/\r?\n|\\n/);
  const results: LintResult[] = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) {
      continue;
    }

    // Parse line: Status:Linter:Severity:Scope:Message
    // Match the first 4 segments separated by colons, and the rest is the message
    const match = line.match(/^([^:]+):([^:]+):([^:]+):([^:]+):(.*)$/);
    if (match) {
      let [_, status, linter, severity, scope, message] = match;

      // Clean up escaped quotes inside the segments if any
      status = status.replace(/\\"/g, '"');
      linter = linter.replace(/\\"/g, '"');
      severity = severity.replace(/\\"/g, '"');
      scope = scope.replace(/\\"/g, '"');
      message = message.replace(/\\"/g, '"');

      // Replace markdown bold **text** with HTML <strong>text</strong>
      message = message.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

      results.push({
        status: status.trim(),
        linter: linter.trim(),
        severity: severity.trim(),
        scope: scope.trim(),
        message: message.trim()
      });
    } else {
      // Fallback if formatting differs
      results.push({
        status: "UNKNOWN",
        linter: "unknown",
        severity: "info",
        scope: "dataset",
        message: line.replace(/\\"/g, '"')
      });
    }
  }
  return results;
}

function getWebviewContent(results: LintResult[]): string {
  const total = results.length;
  const passCount = results.filter((r) => r.status.toLowerCase().includes("pass")).length;
  const failCount = results.filter((r) => r.status.toLowerCase().includes("fail") || r.status.toLowerCase().includes("errored")).length;
  const naCount = total - passCount - failCount;

  const tableRows = results
    .map((r, i) => {
      let statusClass = "badge-status-na";
      const statusLower = r.status.toLowerCase();
      if (statusLower.includes("pass")) {
        statusClass = "badge-status-pass";
      } else if (statusLower.includes("fail") || statusLower.includes("errored")) {
        statusClass = "badge-status-fail";
      } else if (statusLower.includes("warning")) {
        statusClass = "badge-status-warning";
      }

      const severityClass = r.severity.toLowerCase() === "important" ? "badge-severity-important" : "badge-severity-info";

      // Standardize status value for client filtering
      let filterStatus = "na";
      if (statusLower.includes("pass")) {
        filterStatus = "pass";
      } else if (statusLower.includes("fail") || statusLower.includes("errored")) {
        filterStatus = "fail";
      }

      return `
      <tr data-status="${filterStatus}" data-severity="${r.severity.toLowerCase()}" data-index="${i}">
        <td><span class="badge ${statusClass}">${r.status}</span></td>
        <td><span class="scope-text code-font">${r.scope}</span></td>
        <td><span class="linter-text code-font">${r.linter}</span></td>
        <td><span class="badge ${severityClass}">${r.severity}</span></td>
        <td class="message-text">${r.message}</td>
      </tr>
    `;
    })
    .join("");

  const resultsDataJson = JSON.stringify(results);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DataLinter for R Output</title>
    <style>
        :root {
            --color-pass-bg: rgba(16, 185, 129, 0.15);
            --color-pass-text: #34d399;
            --color-fail-bg: rgba(239, 68, 68, 0.15);
            --color-fail-text: #f87171;
            --color-na-bg: rgba(107, 114, 128, 0.15);
            --color-na-text: #9ca3af;
            --color-warning-bg: rgba(245, 158, 11, 0.15);
            --color-warning-text: #fbbf24;
            
            --color-important-bg: rgba(249, 115, 22, 0.2);
            --color-important-text: #fdba74;
            --color-info-bg: rgba(59, 130, 246, 0.15);
            --color-info-text: #93c5fd;

            --card-bg: rgba(255, 255, 255, 0.03);
            --card-border: rgba(255, 255, 255, 0.08);
            --input-bg: var(--vscode-input-background, #252526);
            --input-border: var(--vscode-input-border, #3c3c3c);
            --input-color: var(--vscode-input-foreground, #cccccc);
            
            --filter-active-bg: var(--vscode-button-background, #0e639c);
            --filter-active-text: var(--vscode-button-foreground, #ffffff);
            --filter-inactive-bg: rgba(255, 255, 255, 0.05);
            --filter-inactive-text: var(--vscode-editor-foreground, #cccccc);
        }

        body.vscode-light {
            --color-pass-bg: rgba(16, 185, 129, 0.15);
            --color-pass-text: #059669;
            --color-fail-bg: rgba(220, 38, 38, 0.12);
            --color-fail-text: #dc2626;
            --color-na-bg: rgba(107, 114, 128, 0.15);
            --color-na-text: #4b5563;
            --color-warning-bg: rgba(217, 119, 6, 0.15);
            --color-warning-text: #d97706;

            --color-important-bg: rgba(234, 88, 12, 0.12);
            --color-important-text: #ea580c;
            --color-info-bg: rgba(37, 99, 235, 0.12);
            --color-info-text: #2563eb;

            --card-bg: rgba(0, 0, 0, 0.02);
            --card-border: rgba(0, 0, 0, 0.08);
            --filter-inactive-bg: rgba(0, 0, 0, 0.05);
        }

        body {
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            padding: 24px;
            margin: 0;
            box-sizing: border-box;
        }

        * {
            box-sizing: border-box;
        }

        /* Header */
        .header-container {
            margin-bottom: 24px;
        }
        .header-title {
            font-size: 20px;
            font-weight: 600;
            margin: 0 0 6px 0;
            color: var(--vscode-editor-foreground);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-subtitle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #8c8c8c);
            margin: 0;
        }

        /* Metrics Grid */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .metric-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
            display: flex;
            flex-direction: column;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }
        .metric-card:hover {
            transform: translateY(-2px);
            border-color: rgba(255, 255, 255, 0.15);
        }
        body.vscode-light .metric-card:hover {
            border-color: rgba(0, 0, 0, 0.15);
        }
        .metric-val {
            font-size: 28px;
            font-weight: 700;
            line-height: 1;
            margin-bottom: 6px;
        }
        .metric-lbl {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground, #8c8c8c);
            font-weight: 500;
        }

        /* Left-accent borders for metric cards */
        .metric-card::before {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            background: var(--color-na-text);
        }
        .metric-card.metric-pass::before {
            background: var(--color-pass-text);
        }
        .metric-card.metric-fail::before {
            background: var(--color-fail-text);
        }
        .metric-card.metric-total::before {
            background: var(--vscode-textLink-foreground, #007acc);
        }

        /* Search & Filter Container */
        .search-filter-container {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            align-items: center;
            justify-content: space-between;
        }
        .search-wrapper {
            flex: 1 1 300px;
            position: relative;
        }
        #search-input {
            width: 100%;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            color: var(--input-color);
            border-radius: 4px;
            padding: 8px 12px;
            outline: none;
            font-family: inherit;
            font-size: 13px;
            transition: border-color 0.2s;
        }
        #search-input:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .filters {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            align-items: center;
        }
        .filter-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .filter-label {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground, #8c8c8c);
        }
        .filter-btn {
            background: var(--filter-inactive-bg);
            color: var(--filter-inactive-text);
            border: 1px solid var(--card-border);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: inherit;
            transition: all 0.2s;
        }
        .filter-btn:hover {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .filter-btn.active {
            background: var(--filter-active-bg);
            color: var(--filter-active-text);
            border-color: var(--filter-active-bg);
            font-weight: 500;
        }

        /* Results Status Summary Text */
        .status-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #8c8c8c);
            margin-bottom: 12px;
            font-weight: 500;
        }

        /* Table styling */
        .results-table-wrapper {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            overflow: hidden;
        }
        .results-table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }
        .results-table th {
            background: rgba(0, 0, 0, 0.15);
            padding: 12px 16px;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground, #8c8c8c);
            border-bottom: 1px solid var(--card-border);
        }
        body.vscode-light .results-table th {
            background: rgba(0, 0, 0, 0.03);
        }
        .results-table td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--card-border);
            vertical-align: middle;
            line-height: 1.5;
        }
        .results-table tr:last-child td {
            border-bottom: none;
        }
        .results-table tr {
            transition: background-color 0.15s;
        }
        .results-table tr:hover {
            background-color: rgba(255, 255, 255, 0.015);
        }
        body.vscode-light .results-table tr:hover {
            background-color: rgba(0, 0, 0, 0.01);
        }

        .results-table tr.hidden {
            display: none;
        }

        /* Badges */
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-align: center;
            white-space: nowrap;
        }
        .badge-status-pass {
            background: var(--color-pass-bg);
            color: var(--color-pass-text);
        }
        .badge-status-fail {
            background: var(--color-fail-bg);
            color: var(--color-fail-text);
        }
        .badge-status-na {
            background: var(--color-na-bg);
            color: var(--color-na-text);
        }
        .badge-status-warning {
            background: var(--color-warning-bg);
            color: var(--color-warning-text);
        }

        .badge-severity-important {
            background: var(--color-important-bg);
            color: var(--color-important-text);
            border: 1px solid rgba(249, 115, 22, 0.3);
        }
        .badge-severity-info {
            background: var(--color-info-bg);
            color: var(--color-info-text);
            border: 1px solid rgba(59, 130, 246, 0.3);
        }

        .code-font {
            font-family: var(--vscode-editor-font-family, Consolas, Monaco, monospace);
            font-size: 12px;
            background: rgba(255, 255, 255, 0.04);
            padding: 2px 6px;
            border-radius: 4px;
        }
        body.vscode-light .code-font {
            background: rgba(0, 0, 0, 0.04);
        }

        .scope-text {
            font-weight: 500;
        }

        .message-text strong {
            font-weight: 600;
            color: var(--vscode-editor-foreground);
        }
    </style>
</head>
<body>
    <div class="header-container">
        <h1 class="header-title">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M7.56 1a1 1 0 01.88 0l6 3.25a1 1 0 01.56.89v5.72a1 1 0 01-.56.89l-6 3.25a1 1 0 01-.88 0l-6-3.25A1 1 0 011 10.86V5.14a1 1 0 01.56-.89l6-3.25zM8 2.1L2.67 5 8 7.9 13.33 5 8 2.1zm5.33 4v4.3L8.5 13.1v-4.3l4.83-2.8zM7.5 13.1l-4.83-2.8V6.1L7.5 8.8v4.3z"/>
            </svg>
            DataLinter for R Results
        </h1>
        <p class="header-subtitle">Analysis results for selected R variable data</p>
    </div>

    <div class="metrics-grid">
        <div class="metric-card metric-total">
            <div class="metric-val" id="count-total">${total}</div>
            <div class="metric-lbl">Total Checks</div>
        </div>
        <div class="metric-card metric-pass">
            <div class="metric-val" id="count-pass">${passCount}</div>
            <div class="metric-lbl">Passed</div>
        </div>
        <div class="metric-card metric-fail">
            <div class="metric-val" id="count-fail">${failCount}</div>
            <div class="metric-lbl">Failed / Errored</div>
        </div>
        <div class="metric-card metric-na">
            <div class="metric-val" id="count-na">${naCount}</div>
            <div class="metric-lbl">Not Available</div>
        </div>
    </div>

    <div class="search-filter-container">
        <div class="search-wrapper">
            <input type="text" id="search-input" placeholder="Search columns, rules, or messages..." />
        </div>
        <div class="filters">
            <div class="filter-group">
                <span class="filter-label">Status:</span>
                <button class="filter-btn active" data-filter-type="status" data-filter-value="all">All</button>
                <button class="filter-btn" data-filter-type="status" data-filter-value="pass">Pass</button>
                <button class="filter-btn" data-filter-type="status" data-filter-value="fail">Fail/Error</button>
                <button class="filter-btn" data-filter-type="status" data-filter-value="na">N/A</button>
            </div>
            <div class="filter-group">
                <span class="filter-label">Severity:</span>
                <button class="filter-btn active" data-filter-type="severity" data-filter-value="all">All</button>
                <button class="filter-btn" data-filter-type="severity" data-filter-value="important">Important</button>
                <button class="filter-btn" data-filter-type="severity" data-filter-value="info">Info</button>
            </div>
        </div>
    </div>

    <div class="status-text" id="displaying-text">
        Showing ${total} of ${total} checks
    </div>

    <div class="results-table-wrapper">
        <table class="results-table">
            <thead>
                <tr>
                    <th style="width: 10%;">Status</th>
                    <th style="width: 20%;">Scope / Column</th>
                    <th style="width: 20%;">Linter Rule</th>
                    <th style="width: 15%;">Severity</th>
                    <th style="width: 35%;">Message</th>
                </tr>
            </thead>
            <tbody id="results-body">
                ${tableRows}
            </tbody>
        </table>
    </div>

    <script>
        const results = ${resultsDataJson};
        
        let activeStatusFilter = 'all';
        let activeSeverityFilter = 'all';
        let searchQuery = '';

        const searchInput = document.getElementById('search-input');
        const filterBtns = document.querySelectorAll('.filter-btn');
        const rows = document.querySelectorAll('#results-body tr');
        const displayingText = document.getElementById('displaying-text');

        // Filter button clicks
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-filter-type');
                const val = btn.getAttribute('data-filter-value');
                
                // Toggle active class inside the group
                document.querySelectorAll(\`.filter-btn[data-filter-type="\${type}"]\`).forEach(b => {
                    b.classList.remove('active');
                });
                btn.classList.add('active');

                if (type === 'status') activeStatusFilter = val;
                if (type === 'severity') activeSeverityFilter = val;

                updateDisplay();
            });
        });

        // Search input
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase().trim();
            updateDisplay();
        });

        function updateDisplay() {
            let visibleCount = 0;
            let visiblePass = 0;
            let visibleFail = 0;
            let visibleNa = 0;

            rows.forEach(row => {
                const index = parseInt(row.getAttribute('data-index'));
                const item = results[index];

                const matchesStatus = activeStatusFilter === 'all' || row.getAttribute('data-status') === activeStatusFilter;
                const matchesSeverity = activeSeverityFilter === 'all' || row.getAttribute('data-severity') === activeSeverityFilter;
                
                const rawText = (item.scope + ' ' + item.linter + ' ' + item.message).toLowerCase();
                const matchesSearch = searchQuery === '' || rawText.includes(searchQuery);

                if (matchesStatus && matchesSeverity && matchesSearch) {
                    row.classList.remove('hidden');
                    visibleCount++;
                    
                    const statusLower = item.status.toLowerCase();
                    if (statusLower.includes('pass')) {
                        visiblePass++;
                    } else if (statusLower.includes('fail') || statusLower.includes('errored')) {
                        visibleFail++;
                    } else {
                        visibleNa++;
                    }
                } else {
                    row.classList.add('hidden');
                }
            });

            // Update status text
            displayingText.textContent = \`Showing \&nbsp;\${visibleCount} of \${results.length} checks\`;

            // Update counter numbers
            document.getElementById('count-total').textContent = visibleCount;
            document.getElementById('count-pass').textContent = visiblePass;
            document.getElementById('count-fail').textContent = visibleFail;
            document.getElementById('count-na').textContent = visibleNa;
        }
    </script>
</body>
</html>`;
}
