var firstPlaythrough = true;
var playing = false;
var soundMuted = false;

var bells = new Array();
var bellsIndex = randomXToY(0,4);
var endSound = ((new Audio()).canPlayType("audio/ogg; codecs=vorbis") != "") ? new Audio("sound/end.ogg") : new Audio("sound/end.mp3");

for(var i = 0; i < 10; i++){
	var index = (i < 5) ? i : i - 5;
    if((new Audio()).canPlayType("audio/ogg; codecs=vorbis") != ""){
        bells[i] = new Audio("sound/_bell"+index+".ogg");
    }else{
        bells[i] = new Audio("sound/_bell"+index+".mp3");
    }
}


function jsSoundMuted(){
	return soundMuted;
}

function jsSetSoundMuted(m){
	soundMuted = !!m;
	$("#hud").toggleClass("muted", soundMuted);
	$("#sound-toggle").toggleClass("muted", soundMuted);
	$("#sound-icon").html(soundMuted ? "&#9834;" : "&#9835;");
	$("#sound-label").html(soundMuted ? "OFF" : "ON");
}

function jsUpdateBest(){
	var hs = parseInt(localStorage["highScore"], 10);
	if(!isNaN(hs) && hs > 0){
		$("#hud #best").html("BEST " + addCommas(hs));
	}else{
		$("#hud #best").html("");
	}
}

function jsUpdateSpeed(speed){
	var s = Number(speed);
	if(isNaN(s) || s <= 0){ return; }
	//Gauge is progress toward the absolute terminal speed, so a fresh run
	//reads ~31% and the top level reads 100% instead of re-baselining.
	var max = (pjs && typeof pjs.getMaxSpeed === "function") ? Number(pjs.getMaxSpeed()) : 0;
	if(!(max > 0)){ max = 0.008; }
	var pct = Math.max(0, Math.min(100, Math.round((s / max) * 100)));
	$("#hud #speed-fill").css("width", pct + "%");
	$("#hud #speed-track #speed-max-tick").css("left", "calc(" + pct + "% - 1px)");
	$("#hud #speed-value").html(pct + "%");
	$("#hud #speed-caption-text").html(pct >= 90 ? "terminal velocity" : "hover to speed up");
}

//Live "how far to the next level" readout, driven by the sketch's own thresholds.
function jsUpdateProgress(score, level){
	if(!pjs || typeof pjs.progressForScore !== "function"){ return; }
	var pct = Math.round(pjs.progressForScore(parseInt(score, 10) || 0, parseInt(level, 10) || 1));
	pct = Math.max(0, Math.min(100, pct));
	$("#hud #level-progress-fill").css("width", pct + "%");
	$("#hud #progress-pct").html(pct + "%");
}

//Close-call streak badge; auto-clears so it can never get stuck on screen.
var streakBadgeTimer = null;

function jsNearMiss(streak, bonus){
	var s = parseInt(streak, 10) || 0;
	if(s > 0){
		$("#hud #streak-badge").html("CLOSE CALL x" + s + " &middot; +" + (parseInt(bonus, 10) || 0));
		$("#hud #streak-badge").stop(true, true).show();
		if(streakBadgeTimer){
			clearTimeout(streakBadgeTimer);
		}
		streakBadgeTimer = setTimeout(function(){
			$("#hud #streak-badge").fadeOut(400);
			streakBadgeTimer = null;
		}, 1200);
	}else{
		if(streakBadgeTimer){
			clearTimeout(streakBadgeTimer);
			streakBadgeTimer = null;
		}
		$("#hud #streak-badge").stop(true, true).hide();
	}
}

function jsSetRunSummary(text){
	$("#gameover-menu #run-summary").html(text || "");
}

function jsToggleSound(){
	jsSetSoundMuted(!soundMuted);
	return soundMuted;
}

// --- pointer / touch steering: drag anywhere on the tunnel to fly ---
// The sketch owns all flight physics; JS only reports raw pointer state and
// maps event coordinates into the 800x800 sketch space.
function pointerToSketchCoords(event){
	var canvas = document.getElementById("polybranch");
	var cx, cy;
	if(event && event.pageX !== undefined){
		cx = event.pageX; cy = event.pageY;
	}else{
		cx = 0; cy = 0;
	}
	if(!canvas || !canvas.getBoundingClientRect){
		return { x: cx, y: cy };
	}
	var rect = canvas.getBoundingClientRect();
	var x = (cx - rect.left) * (canvas.width / rect.width);
	var y = (cy - rect.top) * (canvas.height / rect.height);
	return { x: x, y: y };
}

var pointerSteering = false;
var pointerClearedOnEnd = true;

function jsIsPointerSteering(){
	return pointerSteering;
}

function jsPointerSteerStart(event){
	if(!pjs || typeof pjs.pointerSteerBegin !== "function"){
		return;
	}
	var pt = pointerToSketchCoords(event);
	pointerSteering = true;
	pointerClearedOnEnd = false;
	$("#game-wrapper").addClass("steering");
	pjs.pointerSteerBegin(pt.x, pt.y);
}

function jsPointerSteerMove(event){
	if(!pointerSteering || !pjs || typeof pjs.pointerSteerMove !== "function"){
		return;
	}
	var pt = pointerToSketchCoords(event);
	pjs.pointerSteerMove(pt.x, pt.y);
}

function jsPointerSteerStop(){
	if(!pointerClearedOnEnd && pjs && typeof pjs.pointerSteerEnd === "function"){
		pjs.pointerSteerEnd();
	}
	pointerSteering = false;
	pointerClearedOnEnd = true;
	$("#game-wrapper").removeClass("steering");
}

function bindPointerSteering(){
	var $wrapper = $("#game-wrapper");
	$wrapper.on("mousedown.polybranch", function(event){
		if($(event.target).closest("a, .hud-button, #arrowkeys").length > 0){
			return;
		}
		jsPointerSteerStart(event);
	});
	$(document).on("mousemove.polybranch", function(event){
		jsPointerSteerMove(event);
	});
	$(document).on("mouseup.polybranch", function(){
		jsPointerSteerStop();
	});

	$wrapper.on("touchstart.polybranch", function(event){
		var touch = (event.originalEvent && event.originalEvent.changedTouches && event.originalEvent.changedTouches[0]) || null;
		if(!touch || $(event.target).closest("a, .hud-button").length > 0){
			return;
		}
		jsPointerSteerStart(touch);
		if(event.cancelable){
			event.preventDefault();
		}
	});
	$wrapper.on("touchmove.polybranch", function(event){
		var touch = (event.originalEvent && event.originalEvent.changedTouches && event.originalEvent.changedTouches[0]) || null;
		if(touch){
			jsPointerSteerMove(touch);
		}
		if(event.cancelable){
			event.preventDefault();
		}
	});
	$wrapper.on("touchend.polybranch touchcancel.polybranch", function(){
		jsPointerSteerStop();
	});

	$(window).on("blur.polybranch", function(){
		jsPointerSteerStop();
	});
}



$(document).ready(function(){
	$("#main-menu #start").click(function(){
		if(!playing && pjs){
			jsStartGame(false);
			playing = true;
		}
	});

	$("#gameover-menu #retry").click(function(){
		if(!playing && pjs){
			jsNewGame();
			playing = true;
		}
	});

	$("#gameover-menu #steer-hint").click(function(){
		if(!playing && pjs){
			jsNewGame();
			playing = true;
		}
	});

	$("#hud #pause-toggle").click(function(){
		if(pjs != null){
			pjs.pause();
		}
	});

	$("#hud #sound-toggle").click(function(){
		jsToggleSound();
	});

	bindPointerSteering();

	$(document).bind("keydown",function(event){
		if(event && (event.keyCode === 80)){
			if(pjs != null && playing){
				pjs.pause();
			}
		}
		if(event && (event.keyCode === 77)){
			jsToggleSound();
		}
		if(event && (event.keyCode === 82) && !playing && pjs){
			jsNewGame();
			playing = true;
		}
		if($("#arrowkeys:visible").length > 0){
			$("#arrowkeys").fadeOut(300);
		}
	});
});



// function start(){
// 	if(pjs!=null) {
//     	pjs.pause();
//     }
// }
function processingIsReady(){
	$("#loading").fadeOut(300);
}

function jsPauseMenu(show){
	if(show){
		$("#pause-menu").stop(true, true).fadeIn(180);
	}else{
		$("#pause-menu").stop(true, true).fadeOut(180);
	}
}

function jsStartGame(fromProcessing){
	if(!fromProcessing && pjs){
		pjs.pause();
	}
	jsSetSoundMuted(soundMuted);
	if(pjs){
		jsUpdateNextLevelLive();
	}
	jsUpdateProgress(0, 1);
	jsUpdateBest();
	$("#main-menu .content").fadeOut(300,function(){
		if(firstPlaythrough){
			firstPlaythrough = false;
			$("#arrowkeys").fadeIn(300);
		}
		$("#hud").fadeIn(300);
		$("#main-menu").fadeOut(300,function(){
			
		});
	});
}

function jsNewGame(){
	if(!pjs){
		return; //restart reliability: never let an unbound sketch abort the restart chain
	}
	pjs.newGame();
	$("#hud #score").html("0");
	$("#hud #level span").html("1");
	jsUpdateNextLevelLive();
	jsUpdateBest();
	jsUpdateProgress(0, 1);
	jsUpdateSpeed(0.0025);
	jsSetRunSummary("");
	$("#flash").stop(true, true).hide().css("opacity", "1");
	$("#gameover-menu .content").stop(true, 1).animate({"opacity":"0"},300,function(){
		$("#gameover-menu .content").hide();
		$("#gameover-menu").stop(true, 1).animate({"opacity":"0"},300,function(){
			$("#gameover-menu").hide();
			$("#hud").fadeIn(300);
			if(pjs){ pjs.pause(); }
		});
	});
}

function jsTriggerBell(){
	if(soundMuted){
		return;
	}
	var newIndex = randomXToY(0,4);
	if(newIndex == bellsIndex){
		jsTriggerBell();
	}else{
		bellsIndex = newIndex;
		if(bells[bellsIndex].paused){
			bells[bellsIndex].currentTime=0;
		    bells[bellsIndex].play();
		}else{
			bells[bellsIndex+5].currentTime=0;
		    bells[bellsIndex+5].play();
		}
	}
}

function jsUpdateScore(score){
	$("#hud #score").html(addCommas(score));
	jsUpdateNextLevelLive();
	jsUpdateProgress(score, parseInt($("#hud #level span").html(),10) || 1);
	jsUpdateBest();
}

function jsUpdateNextLevel(next){
	if(!next || next <= 0){
		$("#hud #next-level-hint").html("MAX LEVEL");
	}else{
		$("#hud #next-level-hint").html("NEXT LEVEL AT "+addCommas(next));
	}
}

//Keep the hint truthful while flying: always the sketch's own next threshold.
function jsUpdateNextLevelLive(){
	if(!pjs){ return; }
	var level = parseInt($("#hud #level span").html(),10) || 1;
	if(level >= 12){
		$("#hud #next-level-hint").html("MAX LEVEL");
	}else{
		$("#hud #next-level-hint").html("NEXT LEVEL AT "+addCommas(pjs.getNextScore(level)));
	}
}

//Level-up feedback is applied the moment the sketch's own checkLevel flips
//the level, so the HUD never lags the tunnel behind the real threshold.
function jsLevelUp(level){
	$("#hud #level span").html(level);
	jsUpdateNextLevelLive();
	if(pjs && typeof pjs.getGameScore === "function"){
		jsUpdateProgress(pjs.getGameScore(), level);
	}
}

function jsGameOver(score){
	playing = false;
	if(streakBadgeTimer){ clearTimeout(streakBadgeTimer); streakBadgeTimer = null; }
	$("#hud #streak-badge").stop(true, true).hide();
	$("#flash").show();
	if(!soundMuted){
		endSound.currentTime=0;
		endSound.play();
	}
	var levelReached = parseInt($("#hud #level span").html(),10) || 1;
	var hs = parseInt(localStorage["highScore"],10);
	var isNewRecord = (isNaN(hs) || score > hs);
	var summary = "You reached " + (isNaN(levelReached) ? 1 : levelReached) + " at " + addCommas(score) + " points.";
	//concrete feedback: how much of the run was close-call skill versus clean gates
	var closeCalls = 0;
	var closeBonus = 0;
	if(pjs && typeof pjs.getRunCloseCalls === "function"){
		closeCalls = parseInt(pjs.getRunCloseCalls(), 10) || 0;
		closeBonus = parseInt(pjs.getRunCloseCallBonus(), 10) || 0;
	}
	if(closeCalls > 0){
		summary += " " + closeCalls + " close call" + (closeCalls === 1 ? "" : "s") + " earned " + addCommas(closeBonus) + " bonus points.";
	}else{
		summary += " Not a single close call — clean flying!";
	}
	if(isNewRecord){
		summary += " That is a new personal best.";
	}else{
		summary += " Personal best is " + addCommas(hs) + " points.";
	}
	jsSetRunSummary(summary);
	$("#hud").hide();
	$("#flash").delay(1000).animate({"opacity":0}, 1000,function(){
		$(this).hide();
		$(this).css("opacity","1");
		$("#gameover-menu #score").html(addCommas(score)+"<span id='L'>L"+$("#hud #level span").html()+"</span>");
		if(isNewRecord){
			$("#gameover-menu #highscore").html("NEW RECORD!");
			localStorage["highScore"] = score;
			localStorage["highLevel"] = $("#hud #level span").html();
		}else{
			$("#gameover-menu #highscore").html("PERSONAL BEST: "+addCommas(parseInt(localStorage["highScore"]))+"<span id='L'>L"+localStorage["highLevel"]+"</span>");
		}
		var levelReached = parseInt($("#hud #level span").html(),10) || 1;
		var nextTarget = (levelReached >= 12) ? 0 : pjs.getNextScore(levelReached);
		$("#gameover-menu #nextlevel span").html(addCommas(nextTarget));
		jsUpdateNextLevel(nextTarget);
		$("#gameover-menu").show();
		$("#gameover-menu").animate({"opacity":"1"},300,function(){
			$("#gameover-menu .content").show();
			$("#gameover-menu .content").animate({"opacity":"1"},300);
		});
	});
}

//function to get random number upto m
function randomXToY(minVal,maxVal,floatVal)
{
  var randVal = minVal+(Math.random()*(maxVal-minVal));
  return typeof floatVal=='undefined'?Math.round(randVal):randVal.toFixed(floatVal);
}

function addCommas(nStr){
	nStr += '';
	x = nStr.split('.');
	x1 = x[0];
	x2 = x.length > 1 ? '.' + x[1] : '';
	var rgx = /(\d+)(\d{3})/;
	while (rgx.test(x1)) {
		x1 = x1.replace(rgx, '$1' + ',' + '$2');
	}
	return x1 + x2;
}