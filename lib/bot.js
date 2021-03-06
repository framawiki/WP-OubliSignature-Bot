/*
 * WP-OubliSignature-Bot
 *
 * Wikipedia FR Bot that signs when users forget to do so
 * Copyright (C) 2015 Valentin Berclaz
 * <http://www.valentinberclaz.com/>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

// //////
// Vars
var WikimediaStream = require('wikimedia-stream'),
	ws = new WikimediaStream({}),
	Bot = require('nodemw'),
	client = new Bot('lib/config.json'),
	async = require('async'),
	_ = require('lodash'),
	diffMaker = require('diff'),
	escapeStringRegexp = require('escape-string-regexp'),
	Html5Entities = require('html-entities').Html5Entities,
	listOptIn, listOptOut;

// ///////////////////////
// MAIN
try {
	// Create user DB
	updateUserDB();

	// Read stream
	ws.on('data', function(data) {
		handleData(data);
	});

	ws.on('error', function(err) {
		console.log('Error', err);
	});
}
catch (err) {
	console.err(err);
}

// ///////////////////////
// FUNCTIONS
/**
 * Get the data and handle all the steps for processing it
 * @param {Object} data - the data received via the stream
 * @param {string} data.project - the project of the edit
 * @param {string} data.page - the page of the edit
 * @param {string} data.flags - the flags of the edit
 * @param {string} data.url - the url of the edit
 * @param {string} data.user - the user doing the edit
 * @param {string} data.size - the size modification with + or -
 * @param {string} data.comment - the summary of the edit
 */
function handleData(data) {

	// Check if page is elligible (async)
	isDiscussion(data.page, function(err, isDiscussion) {
		if (err) {
			addErrorLine(data.page, data.url, data.user, 'isDiscussion()', err);
			return;
		}

		if (isDiscussion) {
			// Check if user is elligible
			isUserElligible(data.user, data.flags, function(err, isUserElligible) {
				if (err) {
					addErrorLine(data.page, data.url, data.user, 'isUserElligible()', err);
					return;
				}

				if (isUserElligible) {
					console.log('Checking diff on [[' + data.page + ']] by ' + data.user);

					// Get the diff
					getAddedLinesFromUrl(data.url, data.page, function(err, content, addedLines) {
						if (err) {
							addErrorLine(data.page, data.url, data.user, 'getAddedLinesFromUrl()', err);
							return;
						}

						if (addedLines !== null) {
							async.each(addedLines, function(line, callback) {
								var trimmedline = line.trim(); // Remove whitspaces
								// Don't bother testing if it is just a small array
								if (line.length > 5) {
									if (isUnsignedComment(trimmedline, data.page, data.comment, data.user, content)) {
										process.stdout.write('\x07'); // BEEP
										console.log('UNSIGNED MSG DETECTED : ' + data.url);

										client.logIn(function(err) {
											if (err) {
												addErrorLine(data.page, data.url, data.user, 'client.logIn()', err);
												return;
											}

											// Gather data
											var section = getSectionFromResume(data.comment);
											var id = getDiffFromUrl(data.url);
											if (id === null)
												id = getOldidFromUrl(data.url);

											// Sign line and warn user
											signLine(data.page, trimmedline, id, data.user, section, function(err) {
												if (err) {
													addErrorLine(data.page, data.url, data.user, 'signLine()', err);
													return;
												}

												addMsgOnUserPage(data.user, data.page, data.url, function(err) {
													if (err) {
														addErrorLine(data.page, data.url, data.user, 'addMsgOnUserPage()', err);
													}
												});
											});

										});
									}
									console.log('-------------------------------------------------');
									callback();
								}
							});
						}
					});
				}
			});
		}
	});
}

// ///////////////////////
// UPDATE FUNCTIONS
/**
 * Update the user database
 */
function updateUserDB() {
	var tmp;
	listOptIn = [];
	listOptOut = [];
	client.getPagesInCategory('Utilisateur avec contrôle de signature', function(err, data) {
		for (var i = 0; i < data.length; i++) {
			tmp = data[i].title;
			if (tmp.indexOf('Utilisateur:') > -1) {
				listOptIn.push(tmp.replace('Utilisateur:', ''));
			}
		}
	});
	client.getPagesInCategory('Utilisateur sans contrôle de signature', function(err, data) {
		for (var i = 0; i < data.length; i++) {
			tmp = data[i].title;
			if (tmp.indexOf('Utilisateur:') > -1) {
				listOptOut.push(tmp.replace('Utilisateur:', ''));
			}
		}
	});
}

// ///////////////////////
// GET FUNCTIONS
/**
 * Extract the content and the added lines from a diff and oldid or only oldid url
 * @param {string} url - the url with the oldid
 * @param {string} page - the page
 * @param callback
 */
function getAddedLinesFromUrl(url, page, callback) {
	var params,
		oldid = getOldidFromUrl(url),
		diff = getDiffFromUrl(url);

	if (oldid === null) {
		callback(new Error('The page (' + url + ') has no oldid'));
		return;
	}

	params = {
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		rvlimit: 1,
		rvdir: 'newer',
		rvstartid: oldid,
		titles: page
	};

	// If is not a page creation
	if (diff !== null) {
		params.rvlimit = 2;
		params.rvendid = diff;
	}

	client.api.call(params, function(err, info) {
		if (_.has(info, 'pages[' + Object.keys(info.pages)[0] + '].revisions[0]')) {
			var oldrv = info.pages[Object.keys(info.pages)[0]].revisions[0]['*'];

			if (_.has(info, 'pages[' + Object.keys(info.pages)[0] + '].revisions[1]')) {
				var newrv = info.pages[Object.keys(info.pages)[0]].revisions[1]['*'];
				callback(null, newrv, getAddedLines(oldrv, newrv));
			} else {
				callback(null, oldrv, [oldrv]);
			}
		} else {
			callback(new Error('The page (' + url + ') couldn\'t be loaded.'));
		}
	});
}

/**
 * Get the section if included in the resume
 * @param {string} resume - the resume to parse
 * @return {string}
 */
function getSectionFromResume(resume) {
	if (typeof resume == 'undefined')
		return '';

	var match = resume.match(/^(\/\* .+? \*\/)/);
	if (match === null)
		return '';

	return match[1] + ' ';
}


/**
 * Get an oldid from a specific url
 * @param {string} url - the url to parse
 * @return {?number}
 */
function getOldidFromUrl(url) {
	var match = url.match(/oldid=([1-9][0-9]+)/);
	if (match === null)
		return null;

	return Number(match[1]);
}

/**
 * Get a diff id from a specific url
 * @param {string} url - the url to parse
 * @return {?number}
 */
function getDiffFromUrl(url) {
	var match = url.match(/diff=([1-9][0-9]+)/);
	if (match === null)
		return null;

	return Number(match[1]);
}

/**
 * Gives only the added lines back
 * @param {string} oldrv - The old revision content
 * @param {string} newrv - The new revision content
 * @return {string[]} The added lines
 */
function getAddedLines(oldrv, newrv) {
	var diffRaw = diffMaker.diffChars(oldrv, newrv),
		diff = '',
		begintag = '<<BEGINSIGNADDED>>',
		endtag = '<<ENDSIGNADDED>>',
		joinRegex = new RegExp(endtag + '(\\s*)' + begintag, 'g'),
		matchRegex = new RegExp('(^' + begintag + '|' + begintag + '\n+^)([\\s\\S]+?)?' + endtag, 'gm'),
		cleanRegex = new RegExp(begintag + '([\\s\\S]+)' + endtag, 'g');

	// Compose diff entirely (need the context)
	diffRaw.forEach(function(part) {
		if (part.added)
			diff += begintag + part.value + endtag;
		else
			diff += part.value;
	});

	// Join following tags
	diff = diff.replace(joinRegex, '$1');

	// Extract only new lines depending of the context
	var matches = diff.match(matchRegex);
	if (matches === null) {
		return null;
	}

	return matches.replaceArray(cleanRegex, '$1');
}

/**
 * Get the date in a DDMMYY format
 * @returns {string}
 */
function getStringDate() {
	var d = new Date();
	return d.getDay() + '' + d.getMonth() + '' + d.getYear();
}

/**
 * Reformat the 'content' after the signature has been applied
 * @param {string} content - The content to reformat
 * @returns {string}
 */
function getReformatedContentAfterSigning(content) {
	content = content.replace(new RegExp('{{RA fin}} ({{non signé\\|[^}]+?}})'), '$1\n{{RA fin}}');

	return content;
}

// ///////////////////////
// ACTION FUNCTIONS
/**
 * Add a line on the log page
 * @param {string} page - the page to log
 * @param {string} url - the diff url
 * @param {string} user - the user that did the action
 * @param {string} type - the type of edit that failed
 * @param {Error} error - the error
 */
function addErrorLine(page, url, user, type, error) {
	console.error(error);
	client.getArticle('Utilisateur:Signature manquante (bot)/Journal', function(err, content) {
		if (err) {
			console.error(err);
			return;
		}

		var row = ' |----\n | [' + url + ' ~~~~~]  || [[' + page + ']]  || {{u|' + user + '}} || ' + type + '|| ' + error + ' \n |}<!-- END ERRORS -->',
			newcontent = content.replace(' |}<!-- END ERRORS -->', row);

		client.edit('Utilisateur:Signature manquante (bot)/Journal', newcontent, 'Ajout d\'une erreur', function(err) {
			if (err) {
				console.error(err);
			}
		});
	});
}

/**
 * Add a message to the discussion page of a user
 * @param {string} user - the user to warn
 * @param {string} page - the related page
 * @param {string} url - the diff url
 * @param callback
 */
function addMsgOnUserPage(user, page, url, callback) {
	client.getArticle('Discussion utilisateur:' + Html5Entities.decode(user), function(err, content) {
		if (err) {
			callback(err);
			return;
		}

		if (content === undefined)
			content = '';

		if (!isBotAllowedInContent(content))
			return;

		if (!isMessageAllowedByContent(content))
			return;

		if (hasAlreadyBeenMessagedToday(content))
			return;

		var ip = isIPaddress(user) ? '-IP' : '',
			newcontent = content +
				'\n\n{{subst:User:Signature manquante (bot)/Modèle:SignezSVP' +
				ip + '|' + page + '|2=' + url + '|3=' + getStringDate() + '}}\n';

		client.editNotMinor(
			'Discussion utilisateur:' + Html5Entities.decode(user),
			newcontent,
			'[[Aide:Signature/résumé|Signature manquante]] sur [[' + page + ']] !',
			function(err, data) {
				if (err) {
					callback(err);
				}

				callback(null, true);

				console.log(data);
				console.log('Message added');
			}
		);
	});
}

/**
 * Sign the specified line
 * @param {string} page - the page to log
 * @param {string} line - the problematic line
 * @param {number} id - the id of the edit
 * @param {string} user - the user that did the action
 * @param {string} section - the section of the user's action
 * @param callback
 */
function signLine(page, line, id, user, section, callback) {
	// Get the actual content
	client.getArticle(page, function(err, content) {
		if (err) {
			callback(err);
			return;
		}

		// Variables
		var ip = isIPaddress(user) ? '|ip=oui' : '|notif=~~~',
			unsigned = ' {{non signé|' + user + '|~~~~~|' + id + ip + '}}',
			newcontent = content.replace(line, line + unsigned);

		// Perform specific modification
		newcontent = getReformatedContentAfterSigning(newcontent);

		// Perform the edition
		client.edit(
			page,
			newcontent,
			section + 'Ajout automatique d\'une [[Aide:Signature/résumé|signature manquante]]',
			function(err, data) {
				if (err) {
					callback(err);
					return;
				}

				console.log(data);
				callback(null, data);
			}
		);
	});
}

// ///////////////////////
// TEST FUNCTIONS (boolean return)
/**
 * Test if title is a discussion page
 * @param {string} title - the title of the page
 * @param callback
 */
function isDiscussion(title, callback) {
	// Discussion page
	if (title.startsWith('Discussion')) {
		// Not specific subpages
		var regex = new RegExp('/(À faire$|Archiv|Brouillon)', 'i');
		if (regex.test(title))
			callback(null, false);
		else {
			isBotAllowed(title, function(err, value) {
				callback(err, value);
			});
		}
	}
	// Meta WP page
	else if (title.startsWith('Wikipédia:')) {
		isMetaDiscussion(title, function(err, value) {
			if (value) {
				isBotAllowed(title, function(err, value) {
					callback(err, value);
				});
			} else {
				callback(err, false);
			}
		});
	}
	// Not a Discussion page
	else
		callback(null, false);
}

/**
 * Test if the meta page is a discussion area
 * @param {string} title - the title of the page
 * @param callback
 */
function isMetaDiscussion(title, callback) {
	var params = {
		action: 'parse',
		page: title,
		prop: 'properties'
	};

	client.api.call(params, function(err, info) {
		if (_.has(info, 'properties')) {
			for (var i = 0; i < info.properties.length; i++) {
				if (info.properties[i].name !== undefined && info.properties[i].name == 'newsectionlink') {
					callback(null, true);
					return;
				}
			}
			callback(null, false);
		}
	});
}

/**
 * Tets if the user with username is elligible for a correction
 * @param {string} username - the username to check
 * @param {string} flags - the flags of the edit
 * @param callback
 */
function isUserElligible(username, flags, callback) {
	// Don't check bots
	if (flags !== undefined && flags.indexOf('B') != -1) {
		callback(null, false);
		return;
	}

	// Update DB (sometimes)
	if (Math.floor(Math.random() * 10) + 1 == 2)
		updateUserDB();

	// Opt-in
	if (listOptIn !== undefined && listOptIn.indexOf(username) != -1) {
		callback(null, true);
		return;
	}

	// Opt-out
	if (listOptOut !== undefined && listOptOut.indexOf(username) != -1) {
		callback(null, false);
		return;
	}

	// Autopatolled
	isAutopatrolled(username, function(err, result) {
		callback(err, !result);
	});
}

/**
 * Check if a line is an unsigned comment by performing a bunch of test on the line, summary and content
 * @param {string} line - The line to check
 * @param {string} title - The title of the page
 * @param {string} summary - The summary of the edition
 * @param {string} username - The user that did the action
 * @param {string} content - The content (context)
 * @return {boolean}
 */
function isUnsignedComment(line, title, summary, username, content) {
	var regex,
		userregexp = String(escapeStringRegexp(username)).replace(' ', '[ _]'),
		unsignedRegex = new RegExp('({{u\'?\\||\\[\\[(Utilisat(eur|rice)|User|User talk|Spécial:Contributions/|Discussion Utilisat(eur|rice)):)' + userregexp, 'i');

	// Test if it is a complete line
	if (content.indexOf(line + '\n') == -1 && !content.endsWith(line))
		return false;

	// Test the summary
	regex = new RegExp('^(révocation|annulation|/\\* articles à |copie|archiv)', 'i');
	if (regex.test(summary))
		return false;

	// Tests on the whole page
	regex = /\{\{Arbre(.+)}}/i;
	if (regex.test(content))
		return false;

	// If section 0 and own userpage
	if (title.startsWith('Discussion Utilisateur:' + username)) {
		regex = new RegExp('==[\\s\\S]+' + line);
		if (!regex.test(content))
			return false;
	}

	// Test the specifc line
	// List of regexes
	var regexes = [
		unsignedRegex,
		new RegExp('{{\\s*(__|auteurs crédités après|si|suppression immédiate|speedy|sd|dsi|delete' +
			'|db|page conservée|avertissement homonymie|traduit de|wikiprojet|À faire|ip scolaire|ip partagée|icône|arbre|wikipédia n\'est pas un forum|nobots|bots|Wikidata|boite|boîte' +
			'|ne pas archiver|marronnier|non signé)', 'i'), // Modèles
		new RegExp('\\[\\[Catégorie:', 'i'), // Catégorie
		new RegExp('^{?[\\|!]'), // Paramètre de modèle ou tableau
		new RegExp('{\\|'), // Tableau
		new RegExp('^({{.+}}|#REDIRECTION\\[\\[.+]])$'), // Juste un modèle ou redirection
		new RegExp('^\\s+$'), // Seulement du vide
		new RegExp('^ *\\*[^:].+\\n'), // Simple élément de liste à puce
		new RegExp('^(==*).+\\1$'), // Seulement un titre
		new RegExp('^__TOC__$'), // TOC only
		new RegExp('^<div.+</div>$'), // HTML (div)
		new RegExp('^[[(Fichier|File):.+]]') // Fichier only
	];

	// Test each regex - if a regex is true: that's it
	for (var i = 0; i < regexes.length; i++) {
		if (regexes[i].test(line))
			return false;
	}

	// Test if unsigned when decoded and return (final)
	return (!unsignedRegex.test(Html5Entities.decode(line)));
}

/**
 * Check if a user is autopatrolled
 * @param {string} username - The username
 * * @param callback
 */
function isAutopatrolled(username, callback) {
	var params = {
		action: 'query',
		list: 'users',
		usprop: 'groups',
		ususers: username
	};

	client.api.call(params, function(err, info) {
		if (_.has(info, 'users[0].groups')) {
			if (info.users[0].groups.indexOf('autopatrolled') > -1) {
				callback(null, true);
			} else {
				callback(null, false);
			}
		} else {
			callback(null, false); // IP or invalid user
		}
	});
}

/**
 * Check if a specific page allows the bot intervention
 * @param {string} title - The title of the page
 * * @param callback
 */
function isBotAllowed(title, callback) {
	client.getArticle(title, function(err, content) {
		if (err) {
			callback(err);
			return;
		}

		callback(null, isBotAllowedInContent(content));
	});
}

/**
 * Check if the content allows the bot to edit
 * @param {string} content - The content to test
 * @return {boolean}
 */
function isBotAllowedInContent(content) {
	if (content === undefined)
		return false;

	return !(content.indexOf('{{nobots}}') != -1 || /\{\{bots\|[^}]*deny=(all|[^}]*Signature manquante \(bot\))[^}]*}}/i.test(content));
}

/**
 * Check if the content allows the bot to edit
 * @param {string} content - The content to test
 * @return {boolean}
 */
function isMessageAllowedByContent(content) {
	if (content === undefined)
		return false;

	return !(/\{\{bots\|[^}]*optout=(all|[^}]*SignezSVP)[^}]*}}/i.test(content));
}

/**
 * Test if todays timecode is present in 'content'
 * @param {string} content
 * @returns {boolean}
 */
function hasAlreadyBeenMessagedToday(content) {
	if (!content.contains('<!--SBOT-'))
		return false;

	var match = content.match(/<!--SBOT-([0-9]{6})/);

	return (match !== null && match[1] == getStringDate());
}

/**
 * Check if the username is an IP address
 * @param {string} username - The username to test
 * @return {boolean}
 */
function isIPaddress(username) {
	return /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|((([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}:[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){5}:([0-9A-Fa-f]{1,4}:)?[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){4}:([0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){3}:([0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){2}:([0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(([0-9A-Fa-f]{1,4}:){0,5}:((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(::([0-9A-Fa-f]{1,4}:){0,5}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|([0-9A-Fa-f]{1,4}::([0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})|(::([0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){1,7}:))$/// jscs:ignore maximumLineLength
		.test(username);
}

// //////////////////////////////
// PROTOTYPE AND OVERRIDING FUNCTIONS
/**
 * Execute a regex on an entier array
 * @param {RegExp} find - regex to find
 * @param {string} replace - replacement
 * @return {string[]} the array with the new values
 */
Array.prototype.replaceArray = function(find, replace) {
	var replaceArray = this;
	for (var i = 0; i < replaceArray.length; i++) {
		replaceArray[i] = replaceArray[i].replace(find, replace);
	}
	return replaceArray;
};

/**
 * Search for 'search' at the beginning of the String
 * @param {string} search - the string to search for
 * @return {boolean}
 */
String.prototype.startsWith = function(search) {
	return this.indexOf(search) === 0;
};

/**
 * Search for 'search' in the String
 * @param {string} search - the string to search for
 * @return {boolean}
 */
String.prototype.contains = function(search) {
	return this.indexOf(search) !== -1;
};

/**
 * Search for 'search' at the end of String
 * @param {string} search - the string to search for
 * @return {boolean}
 */
String.prototype.endsWith = function(search) {
	var hay = this.toString(),
		pos = hay.length - search.length;

	var lastIndex = hay.indexOf(search, pos);
	return lastIndex !== -1 && lastIndex === pos;
};

/**
 * Perform a non-minor edit
 * @see client.edit() for Documentation
 */
client.editNotMinor = function(title, content, summary, callback) {
	// @see http://www.mediawiki.org/wiki/API:Edit
	client.getToken(title, 'edit', function(err, token) {
		if (err) {
			callback(err);
			return;
		}

		var params = {
			action: 'edit',
			title: title,
			text: content,
			bot: '',
			notminor: '',
			summary: summary,
			token: token
		};

		client.api.call(params, function(err, data) {
			if (!err && data.result && data.result === 'Success') {
				callback(null, data);
			} else {
				callback(new Error('Edit failed: ' + err));
			}
		}, 'POST');
	});
};
