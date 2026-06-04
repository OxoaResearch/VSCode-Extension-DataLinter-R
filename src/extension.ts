// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "datalinter-r-cli-runner" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('r-server-runner.runTool', async () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello from DataLinter for R!');

		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const selectedCode = editor.document.getText(editor.selection);
		if (!selectedCode) {
			vscode.window.showWarningMessage("Please select some R code first.");
			return;
		}

		// Extract the R variable name from the selected code
		// Supports patterns like: data = out1, data <- out1, data=out1, data<-out1
		// const assignmentMatch = selectedCode.match(/^\s*\w+\s*(?:<-|=)\s*(\w+)\s*$/);
		// let rVarName: string;
		// if (assignmentMatch) {
		// 	// Use the right-hand side variable name (e.g., "out1" from "data = out1")
		// 	rVarName = assignmentMatch[1];
		// } else {
		// 	// Fall back to using the entire selected text as the variable name
		// 	rVarName = selectedCode.trim();
		// }

		const regex = /data = (\w+)/;
		const matchResult = selectedCode.match(regex);
		let rVarName = "";
		if (matchResult) {
			rVarName = matchResult[1];
		}

		//let rVarName = "out1";

		// --- Method 1: Terminal + Temp File ---
		const terminal = vscode.window.activeTerminal;
		if (!terminal) {
			vscode.window.showErrorMessage("No active terminal found. Please start an R session in the terminal.");
			return;
		}

		// Create a temporary file path to store the CSV output
		const tempFile = path.join(os.tmpdir(), `r_var_${Date.now().toString()}.csv`); //TODO: use the .vscode folder to store the temp file
		const rSafePath = tempFile.replace(/\\/g, '/');

		// Send command to the active terminal to write the dataframe to the temporary CSV file
		terminal.sendText(`tryCatch({ write.csv(${rVarName}, '${rSafePath}', row.names=FALSE) }, error = function(e) { message("Error extracting variable: ", e$message) })`);


		let variableData = "";
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Retrieving dataset '${selectedCode}' from R...`,
			cancellable: false
		}, async () => {
			return new Promise<void>((resolve) => {
				let retries = 0;
				const interval = setInterval(() => {
					if (fs.existsSync(tempFile)) {
						clearInterval(interval);
						try {
							// Read the generated CSV and delete the temp file
							variableData = fs.readFileSync(tempFile, 'utf8');
							fs.unlinkSync(tempFile);
							resolve();
						} catch (e) {
							console.error(e);
							resolve();
						}
					} else if (retries > 20) {
						// Timeout after 10 seconds (20 * 500ms)
						clearInterval(interval);
						vscode.window.showErrorMessage("Timeout waiting for R to evaluate variable. Is R running in the terminal?");
						resolve();
					}
					retries++;
				}, 500);
			});
		});

		// If we couldn't retrieve the data, abort the command
		if (!variableData) {
			return;
		}

		const config = vscode.workspace.getConfiguration('rServerRunner');
		const url = config.get<string>('serverUrl') || 'http://localhost:10000/api/lint';

		const body = {
			"linter_input": {
				"options": {
					"show_na": true,
					"show_passing": true,
					"show_stats": true
				},
				"context": {
					"data_header": true,
					"data_delim": ",",
					"data_type": "dataset",
					"data": variableData,
					"code": selectedCode,
					"linters": ["all"]
				}
			}
		};

		// Show a progress notification
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Sending code to Data Linter for R Server...",
			cancellable: false
		}, async () => {
			try {
				// Send the POST request
				const response = await axios.post(url, body);

				// Display results in a Webview
				const panel = vscode.window.createWebviewPanel(
					'rResult', 'R Server Output', vscode.ViewColumn.Beside, {}
				);

				// Assuming your server returns JSON with a 'result' field
				const displayContent = typeof response.data === 'object'
					? JSON.stringify(response.data, null, 2)
					: response.data.linting_outputs;

				const displayContent2 = displayContent.replace(/\n/g, '<br>');
				panel.webview.html = `<html><body>${displayContent2}</body></html>`;

			} catch (error: any) {
				``
				vscode.window.showErrorMessage(`Server Error: ${error.message}`);
			}
		});
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
