import { test, expect, errors } from '@playwright/test';
import { EnvPool } from '../environments';
import * as fs from 'fs';
import { parse as yamlParse } from 'yaml'

const CSAE_ENV_PASSWORD = process.env.CSAE_ENV_PASSWORD || 'asdfasdf';
const CSAE_WORKERS_COUNT = parseInt(process.env.CSAE_WORKERS_COUNT || '1');
const CSAE_PARALLEL_TESTS_COUNT = parseInt(process.env.CSAE_PARALLEL_TESTS_COUNT || '1');
const envPool = new EnvPool(Math.floor(CSAE_WORKERS_COUNT / CSAE_PARALLEL_TESTS_COUNT));

const CSAE_CI_JOB_IDX = parseInt(process.env.CSAE_CI_JOB_IDX || '0');
const CSAE_CI_JOB_COUNT = parseInt(process.env.CSAE_CI_JOB_COUNT || '1');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test.describe.configure({ mode: 'parallel' });
// files.txt will contain the list of files to be tested.
// It is generated by the following command:
// find .. -name '*.ipynb' | grep 'Getting_Started/' > ./files.txt
// find .. -name '*.ipynb'  > ./files.txt
const FILE_NAME = './files.txt';
const SKIPFILE_NAME = './skip_files.txt';

interface TestData {
    inputs: Input[]
}
interface Input {
    type: string
    value: string
    prompt: string
    cell: number
}

function readFileIntoArray(filename) {
    try {
        const data = fs.readFileSync(filename, 'utf8');
        const lines = data.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        return lines;
    } catch (err) {
        console.error(`Error reading file '${FILE_NAME}': ${err.message}`);
        return [];
    }
}

function loadTestData(filename): Input[] {
    const filenameArray = filename.split('/')
    filenameArray[filenameArray.length - 1] = '.'+filenameArray[filenameArray.length - 1].replace(/.ipynb$/, '.yaml');
    const testDataFilename = filenameArray.join('/');
    if (fs.existsSync(testDataFilename)){
        return (yamlParse(fs.readFileSync(testDataFilename, 'utf8')) as TestData).inputs;
    }
    return []
}

const skipfiles = readFileIntoArray(SKIPFILE_NAME)
const files = readFileIntoArray(FILE_NAME).filter((name) => skipfiles.indexOf(name) === -1);

const testCount = Math.ceil(files.length / CSAE_CI_JOB_COUNT);

for (let i = 0; i < testCount; i++) {

    const idx = i * CSAE_CI_JOB_COUNT + CSAE_CI_JOB_IDX;
    if (idx >= files.length) {
        break;
    }
    const name = files[idx];
    if (name === '') {
        continue;
    }


    test(`test ${i}: ${name}`, async ({ page }, testInfo) => {
        test.setTimeout(10800000);

        // Get the test data inputs
        let inputs: Input[] = loadTestData(name);

        // Create Env or get existing Env
        const env = await envPool.getEnv(testInfo.parallelIndex);
        console.log('url:' + env.getJuypterUrl(name.substring(3)));
        await page.goto(env.getJuypterUrl(name.substring(3)));

        await page.waitForLoadState();

        const juypterNotebookData = JSON.parse(fs.readFileSync(name, 'utf8'));

        let strKernelType = '';
        if (juypterNotebookData.metadata.kernelspec.language === 'python') {
            strKernelType = "Python 3 (ipykernel) ";
        }
        else if (juypterNotebookData.metadata.kernelspec.language === 'Teradata SQL') {
            strKernelType = 'Teradata SQL ';
        } else if (juypterNotebookData.metadata.kernelspec.language === 'R') {
            strKernelType = 'R ';
        }

        console.log('Kernel Type: ' + strKernelType);
        expect(strKernelType).not.toBe('');

        await page.locator('span[class="f1235lqo"] >> text="' + strKernelType + '| Idle"').waitFor({ timeout: 600000 });

        //Get the number of cells in the notebook
        const jpCells = await page.locator('div.jp-NotebookPanel:not(.p-mod-hidden)> div > div.jp-Cell');
        await jpCells.first().waitFor({ timeout: 300000 });
        console.log('Number of cells: ' + await jpCells.count());

        var dm = await juypterNotebookData.cells.length; // Default Number of iterations for each Notebook demo

        //Clicking to activate the note book
        jpCells.first().click();

        for (let i = 1; i <= dm; i++) {
            // To continute the notebook the kernel should be in Idle state. i.e previous cell execution should be completed.
            await page.locator('span[class="f1235lqo"] >> text="' + strKernelType + '| Idle"').waitFor({ timeout: 600000 });

            //Check for any errors so far
            await expect(page.locator(".jp-RenderedText[data-mime-type='application/vnd.jupyter.stderr']")).toHaveCount(0);
            await expect(page.locator(`div.jp-NotebookPanel:not(.p-mod-hidden)> div > div.jp-Cell:nth-child(${i})`)).toHaveClass(/jp-mod-active/);

            // Go to next step by clicking the Run button
            await page.getByRole('button', { name: 'Run the selected cells and' }).click();

            const inputField = await page.locator('input[class="jp-Stdin-input"]')
            // Wait to see if the kernel is started because of the cell execution (some cell does not have execution like text).
            try {
                await page.locator('span[class="f1235lqo"] >> text="' + strKernelType + '| Busy"').waitFor({ timeout: 2000 });
                //wait for input field to appear or else error out and continue to kernal Idle state.
                await inputField.waitFor({ timeout: 3000 });
            } catch (e) {
                if (e instanceof errors.TimeoutError) {
                    continue;
                }
                throw e;
            }
           
            if (await inputField.isVisible()) {
                
                console.log('input prompt appeared at cell ' + i);
                //defaults
                let input = CSAE_ENV_PASSWORD;
                let inputData = inputs ? inputs.find(input => input.cell === i) : undefined;
                
                for(let j=0;j<inputs.length;j++){
                    if(inputs[j].cell === i){
                        inputData = inputs[j];
                        break;
                    }
                    if(inputs[j].prompt && await page.locator('pre[class="jp-Stdin-prompt"]',{hasText:inputs[j].prompt}).isVisible()){
                        inputData = inputs[j];
                        break;
                    }
                }

                if (inputData) {
                    switch (inputData.type) {
                        case 'env':
                            input = process.env[inputData.value]!;
                            break;
                        case 'text':
                            input = inputData.value;
                            break;
                    }
                } else {
                    //all generalized inputs and actions are done here
                    if (await page.getByText('Please Enter OpenAI API key:', { exact: true }).isVisible()) {
                        input = process.env.CSAE_OPENAPI_KEY!;
                    }

                    
                }

                //fill the input field and press enter to continue
                await page.fill('input[class="jp-Stdin-input"]', input);
                await page.locator('input[class="jp-Stdin-input"]').click();
                await page.keyboard.press('Enter');
                await page.keyboard.press('ArrowDown');
            }
            
            // If same cell is active after execution, adding some wait here.
            try {
                await page.locator(`div.jp-NotebookPanel:not(.p-mod-hidden)> div > div.jp-Cell:nth-child(${i}).jp-mod-active`).waitFor({ timeout: 3000 });
            } catch (e) {
                if (e instanceof errors.TimeoutError) {
                    continue;
                }
                throw e;
            }

            // cursor should have moved to next cell
            await expect(page.locator(`div.jp-NotebookPanel:not(.p-mod-hidden)> div > div.jp-Cell:nth-child(${i+1})`)).toHaveClass(/jp-mod-active/);
            
        }
    });
}