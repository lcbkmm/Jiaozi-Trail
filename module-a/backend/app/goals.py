"""Shared goal semantics: conjunction of alternatives, plus ordered visits."""
from app.schemas import VisitGoal


def required_goals(preferences):
    return [VisitGoal(any_of=[tag]) for tag in preferences.required_experiences] + preferences.required_goals


def matches(goal, stop):
    return bool(set(goal.any_of) & set(stop.interests) or stop.place_id in goal.place_ids)


def covered(goal, stops):
    return any(matches(goal, stop) for stop in stops)


def sequence_progress(sequence, stops):
    index=0
    for stop in stops:
        if index==len(sequence): break
        if matches(sequence[index],stop):
            index+=1
        elif any(matches(goal,stop) for goal in sequence[index+1:]):
            return -1
    return index


def vocabulary_tags(preferences):
    return set(preferences.interests + preferences.excluded_interests + preferences.required_experiences) | {
        tag for goal in preferences.required_goals + preferences.visit_sequence for tag in goal.any_of}
