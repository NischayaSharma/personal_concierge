const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const { time } = require('console');
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();
// import OpenAI from "openai";

const app = express();
const PORT = 3000 || process.env.PORT;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION;
const TRIPADVISOR_API_KEY = process.env.TRIPADVISOR_API_KEY;
const openai = new OpenAI({
	apiKey: OPENAI_API_KEY,
	organization: OPENAI_ORGANIZATION,
});
var file_ids = [];
const assistant_ids = fs.readFileSync("./user_data/assistant_id.txt", "utf-8").split("\n");
// console.log(assistant_ids, "Assistant IDs");
assistant_ids.map((id) => {
	if (id != "") {
		openai.beta.assistants.del(id);
	}
});

async function get_flights(origin, destination, date) {
	// const response = await axios.get(`https://www.travelpayouts.com/widgets_suggest_params?q=Из%20${origin}%20в%20${destination}`);
	// const origin_iata = response.data.origin.iata;
	// const destination_iata = response.data.destination.iata;
	// const flights = await axios.get(`https://www.travelpayouts.com/widgets_suggest_params?q=Из%20${origin}%20в%20${destination}&origin_iata=${origin_iata}&destination_iata=${destination_iata}&depart_date=${date}`);
	// return flights.data;

}

async function get_hotels(location, checkin, checkout) {
	let config = {
		method: 'get',
		url: `https://api.content.tripadvisor.com/api/v1/location/search?key=${TRIPADVISOR_API_KEY}&searchQuery=${location}&category=hotels`,
		headers: {
			'accept': 'application/json'
		}
	};

	console.log(config.url);

	var response = await axios.request(config)
	if (response.status == 200) {
		var data = response.data.data;
		for (let hotel of data) {
			delete hotel.address_obj;
			console.log(hotel);
			let location_config = {
				method: 'get',
				url: `https://api.content.tripadvisor.com/api/v1/location/${hotel.location_id}/details?language=en&key=${TRIPADVISOR_API_KEY}&language=en&currency=INR`,
				headers: {
					'accept': 'application/json'
				}
			};
			var location_response = await axios.request(location_config);
			if (location_response.status == 200) {
				var location_data = location_response.data;
				delete location_data.ancestors
				delete location_data.trip_types
				hotel.location_details = location_data;
			}
			console.log(hotel);
		}
		return data;
	}
}

async function createAssistant() {
	var file = await openai.files.create({
		file: fs.createReadStream("./user_data/flights.csv"),
		purpose: "assistants",
	});
	file_ids.push(file.id);
	file = await openai.files.create({
		file: fs.createReadStream("./user_data/user_flight_data.csv"),
		purpose: "assistants",
	});
	file_ids.push(file.id);
	file = await openai.files.create({
		file: fs.createReadStream("./user_data/user_hotel_data.csv"),
		purpose: "assistants",
	});
	file_ids.push(file.id);
	const assistant = await openai.beta.assistants.create(
		{
			"name": "Personal Concierge",
			"instructions": "You are a personal concierge. You'll help in planning and implementing whatever the user asks of you.",
			"model": "gpt-4-1106-preview",
			"tools": [
				{
					"type": "code_interpreter"
				},
				{
					"type": "retrieval"
				},
				// {
				// 	"type": "function",
				// 	"function": {
				// 		"name": "get_flights",
				// 		"description": "Get the flights for the user",
				// 		"parameters": {
				// 			"type": "object",
				// 			"properties": {
				// 				"origin": {
				// 					"type": "string",
				// 					"description": "The origin of the user"
				// 				},
				// 				"destination": {
				// 					"type": "string",
				// 					"description": "The destination of the user"
				// 				},
				// 				"date": {
				// 					"type": "string",
				// 					"description": "The date of the flight"
				// 				}
				// 			},
				// 			"required": ["origin", "destination", "date"]
				// 		}
				// 	}
				// },
				{
					"type": "function",
					"function": {
						"name": "get_hotels",
						"description": "Get the hotels for the user",
						"parameters": {
							"type": "object",
							"properties": {
								"location": {
									"type": "string",
									"description": "The location of the user"
								},
								"checkin": {
									"type": "string",
									"description": "The checkin date of the user"
								},
								"checkout": {
									"type": "string",
									"description": "The checkout date of the user"
								}
							},
							"required": ["location", "checkin", "checkout"]
						}
					}
				}
			],
			"file_ids": file_ids
		}
	);
	console.log("Assistant created", assistant.id);
	fs.writeFile("./user_data/assistant_id.txt", assistant.id, function (err) {
		if (err) {
			// console.log("Error While Writing to File", err);
		}
	});
	return assistant;
}

async function serverInit() {

	var assistant = await createAssistant();
	const assistant_id = assistant.id;

	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));

	app.post('/message', async (req, res) => {
		const body = req.body;
		var thread_id = '';
		var message;
		if ('thread_id' in body) {
			thread_id = body.thread_id;
			const thread = await openai.beta.threads.retrieve(thread_id);
			// console.log(thread, "Thread Retrieved");
			message = await openai.beta.threads.messages.create(
				thread_id,
				{
					"role": "user",
					"content": `Use the Files if neccessary - ${file_ids}\n User Input - ${body.message}`
				}
			);
		}
		else {
			const thread = await openai.beta.threads.create({
				messages: [
					{
						"role": "user",
						"content": `Use the Files if neccessary - ${file_ids}\n User Input - ${body.message}`
					}
				]
			});
			// console.log(thread, "Thread Created");
			thread_id = thread.id;
		}
		var run = await openai.beta.threads.runs.create(
			thread_id,
			{ assistant_id: assistant_id }
		);
		console.log(run, "Run Created");
		var run_id = run.id;
		var run_status = run.status;
		while (!(['completed', 'failed', 'cancelled', 'expired'].includes(run_status))) {
			run = await openai.beta.threads.runs.retrieve(thread_id, run_id);
			run_status = run.status;
			console.log(run_status);
			if (run_status == 'requires_action') {
				if (run.required_action) {
					var tool_calls = run.required_action.submit_tool_outputs.tool_calls;
					console.log(tool_calls, "Tool Calls");
					var tool_call_outputs = [];
					for (let tool_call of tool_calls) {
						const function_name = tool_call.function.name;
						const function_to_call = eval(function_name);
						const function_args = JSON.parse(tool_call.function.arguments);
						const function_output = await function_to_call(function_args.location, function_args.checkin, function_args.checkout);
						tool_call_outputs.push({ tool_call_id: tool_call.id, output: JSON.stringify(function_output) });
					}

					console.log(tool_call_outputs, "Tool Call Outputs");
					run = await openai.beta.threads.runs.submitToolOutputs(
						thread_id,
						run.id,
						{
							tool_outputs: tool_call_outputs
						}
					);

				}
			}
			// console.log(['completed', 'failed', 'cancelled', 'expired'].includes(run_status))
			await new Promise(resolve => setTimeout(resolve, 1000)); // Pause for 1 second
		}
		run = await openai.beta.threads.runs.retrieve(thread_id, run_id);
		// console.log(run, "Run Completed");
		const thread = await openai.beta.threads.retrieve(thread_id);
		// console.log(thread, "Thread Retrieved");
		message = await openai.beta.threads.messages.list(thread_id);
		// console.log(message, "Message Retrieved");
		res.status(200);
		res.send({ message: message.data, thread_id: thread_id });
	});


	app.listen(PORT, (error) => {
		if (!error)
			console.log("Server is Successfully Running, and App is listening on port " + PORT)
		else
			console.log("Error occurred, server can't start", error);
	});
}

serverInit();

