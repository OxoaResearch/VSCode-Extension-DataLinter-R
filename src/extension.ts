// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';

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

		//check if we are currently debugging
		const debugSession = vscode.debug.activeDebugSession;
		if (debugSession) {
			try {
				// Evaluate the selection in the R debug console to get the actual value
				// We wrap it in jsonlite::toJSON or similar if your server expects JSON
				const evaluation = await debugSession.customRequest('stackTrace', { threadId: 1 });
				// const response = await debugSession.evaluate({
				// 	expression: `jsonlite::toJSON(${selection})`,
				// 	frameId: evaluation.stackFrames[0].id,
				// 	context: 'hover'
				// });

				// dataToSend = response.result;
			} catch (err) {
				vscode.window.showWarningMessage("Could not retrieve variable value from debug session. Sending raw text instead.");
			}

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
					"data": "a,b,c\n1,2,3\n4,5,6",
					"code": "",
					"linters": ["all"]
				}
			}
		}

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
					: response.data;

				panel.webview.html = `<html><body><pre>${displayContent}</pre></body></html>`;

			} catch (error: any) {
				vscode.window.showErrorMessage(`Server Error: ${error.message}`);
			}
		});
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
